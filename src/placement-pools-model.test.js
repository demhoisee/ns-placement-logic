"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { scenarios, getPlan } = require("./placement-pools-model.js");

assert.deepEqual(scenarios.map(item => item.id), ["balanced", "affinity", "capacity", "exclusive", "twoaz", "poolblocked"]);
assert.ok(scenarios.every(item => item.dc === "DCE"), "catalog defaults never request automatic DC selection");
assert.equal(getPlan("balanced").datacenter, "DCE", "documented compatibility default");
for (const invalidDC of ["Any DC", "any", "dce", "DCE,DCC", "", null, 0]) {
  assert.throws(() => getPlan("balanced", invalidDC), RangeError);
}
assert.throws(() => getPlan("unknown", "DCE"), RangeError);

for (const dc of ["DCE", "DCC"]) {
  const otherDC = dc === "DCE" ? "DCC" : "DCE";
  for (const scenario of scenarios) {
    const plan = getPlan(scenario.id, dc);
    assert.equal(plan.datacenter, dc);
    assert.equal(plan.scenario.dc, dc);
    assert.equal(plan.inventoryCount, 24);
    assert.equal(plan.clusters.length, 12, "returned inventory is scoped to the selected DC");
    assert.ok(plan.clusters.every(cluster => cluster.dc === dc));
    assert.ok(plan.candidates.every(candidate => candidate.dc === dc && candidate.clusterIds.every(id => id.startsWith(dc + "-"))));
    assert.ok(plan.candidates.every(candidate => candidate.checks.every(check => !check.id.includes(otherDC) && !check.label.includes(otherDC))));
    assert.ok(plan.checkRows.every(row => !row.detail.includes(otherDC)));
    assert.ok(!plan.reason.includes(otherDC), "a plan cannot suggest another DC");
    assert.equal(plan.scenario.affinity, scenario.id === "balanced" ? "No AZ preference" :
      (scenario.id === "exclusive" ? "Only " : "Must include ") + dc + "/AZ2");
    for (const az of ["AZ1", "AZ2", "AZ3"]) {
      const local = plan.clusters.filter(cluster => cluster.az === az);
      assert.deepEqual(local.map(cluster => cluster.name), ["gp1", "ap1", "gp2", "ap2"]);
      assert.ok(local.every(cluster => cluster.cpuCapacity === 24 && cluster.memoryCapacity === 96));
      assert.deepEqual(local.filter(cluster => cluster.pool === "critical").map(cluster => cluster.name), ["gp1", "ap1"]);
      assert.deepEqual(local.filter(cluster => cluster.pool === "standard").map(cluster => cluster.name), ["gp2", "ap2"]);
    }
  }

  const balanced = getPlan("balanced", dc);
  assert.deepEqual(balanced.normal, { cpu: 4, memory: 16 });
  assert.deepEqual(balanced.ceiling, { cpu: 6, memory: 24 });
  assert.equal(3 * balanced.normal.cpu, 12, "normal CPU totals 100%");
  assert.equal(3 * balanced.normal.memory, 48);
  assert.equal(3 * balanced.ceiling.cpu, 18, "protected CPU totals 150%");
  assert.equal(3 * balanced.ceiling.memory, 72);
  assert.equal(2 * balanced.ceiling.cpu, 12, "two survivors restore full demand after scaling");
  assert.equal(2 * balanced.ceiling.memory, 48);
  assert.equal(balanced.ceiling.cpu - balanced.normal.cpu, 2);
  assert.equal(balanced.ceiling.memory - balanced.normal.memory, 8);
  assert.equal(balanced.requiredAZCount, 3);
  assert.equal(balanced.requiredPool, "critical");
  assert.equal(balanced.selected.dc, dc);
  const names = dc === "DCE" ? ["gp1", "ap1", "ap1"] : ["gp1", "gp1", "gp1"];
  assert.deepEqual(balanced.selected.clusterIds, names.map((name, index) => dc + "-AZ" + (index + 1) + "-" + name));
  assert.equal(balanced.candidates.length, 8, "enumerate 2x2x2 combinations within one DC");
  assert.equal(balanced.selected.score, (dc === "DCE" ? 23 : 22) / 24);
  assert.equal(balanced.selected.checks.length, 18);
  assert.equal(balanced.checkRows.length, 4);
  assert.ok(balanced.checkRows.every(row => row.pass));
  for (const candidate of balanced.candidates) {
    const targets = candidate.clusterIds.map(id => balanced.clusters.find(cluster => cluster.id === id));
    assert.equal(new Set(targets.map(cluster => cluster.az)).size, 3);
    assert.ok(targets.every(cluster => cluster.pool === "critical" && cluster.allowedCLs.includes("CL0")));
    assert.equal(candidate.checks.filter(check => check.id.startsWith("normal:")).length, 6);
    for (const failedAZ of ["AZ1", "AZ2", "AZ3"]) {
      const lossChecks = candidate.checks.filter(check => check.id.startsWith("loss-" + failedAZ + ":"));
      assert.equal(lossChecks.length, 4);
      assert.ok(lossChecks.every(check => !check.id.includes("-" + failedAZ + "-")));
      assert.ok(lossChecks.filter(check => check.id.endsWith(":cpu")).every(check => check.detail.startsWith("Needs 6 CPU")));
      assert.ok(lossChecks.filter(check => check.id.endsWith(":memory")).every(check => check.detail.startsWith("Needs 24 GiB")));
    }
  }
  const affinity = getPlan("affinity", dc);
  assert.equal(affinity.selected.dc, dc);
  assert.equal(affinity.candidates.length, 8);
  assert.deepEqual(affinity.selected.clusterIds, balanced.selected.clusterIds);
  assert.ok(affinity.candidates.every(candidate => candidate.clusterIds.some(id => id.startsWith(dc + "-AZ2-"))));

  const capacity = getPlan("capacity", dc);
  assert.equal(capacity.selected, null);
  assert.equal(capacity.policyConflict, false);
  assert.equal(capacity.candidates.length, 8);
  assert.ok(capacity.candidates.every(candidate => !candidate.feasible));
  assert.equal(capacity.checkRows.find(row => row.id === "normal").pass, true);
  assert.equal(capacity.checkRows.find(row => row.id === "loss-AZ1").pass, false);
  assert.equal(capacity.checkRows.find(row => row.id === "loss-AZ2").pass, true);
  assert.equal(capacity.checkRows.find(row => row.id === "loss-AZ3").pass, false);
  assert.ok(capacity.candidates.every(candidate => candidate.checks.filter(check => check.id.endsWith(":memory")).every(check => check.pass)));
  assert.ok(capacity.candidates.every(candidate => candidate.checks.filter(check => !check.pass).every(check => check.id.includes(dc + "-AZ2-") && check.id.endsWith(":cpu"))));
  assert.ok(capacity.clusters.filter(cluster => cluster.az === "AZ2" && cluster.pool === "standard").every(cluster => cluster.cpuFree >= 6 && cluster.memoryFree >= 24));
  assert.match(capacity.reason, /standard-pool headroom cannot be substituted/);

  const exclusive = getPlan("exclusive", dc);
  assert.equal(exclusive.policyConflict, true);
  assert.equal(exclusive.selected, null);
  assert.equal(exclusive.candidates.length, 0);
  assert.equal(exclusive.checkRows[0].id, "policy-conflict");

  const twoaz = getPlan("twoaz", dc);
  assert.equal(twoaz.requiredPool, "standard");
  assert.equal(twoaz.requiredAZCount, 2);
  assert.equal(twoaz.failoverSupported, false);
  assert.deepEqual(twoaz.normal, { cpu: 6, memory: 24 });
  assert.equal(twoaz.candidates.length, 8);
  assert.deepEqual(twoaz.selected.clusterIds, [dc + "-AZ1-gp2", dc + "-AZ2-gp2"]);
  assert.equal(twoaz.checkRows.length, 1);
  assert.match(twoaz.scenario.description, /Illustrative 50\/50/);
  assert.match(twoaz.reason, /no AZ-loss survival guarantee is assigned/);
  for (const candidate of twoaz.candidates) {
    const targets = candidate.clusterIds.map(id => twoaz.clusters.find(cluster => cluster.id === id));
    assert.equal(targets.length, 2);
    assert.equal(new Set(targets.map(cluster => cluster.az)).size, 2);
    assert.ok(targets.some(cluster => cluster.az === "AZ2"));
    assert.ok(targets.every(cluster => cluster.pool === "standard" && cluster.allowedCLs.includes("CL3")));
    assert.equal(candidate.checks.length, 4);
  }
  const poolblocked = getPlan("poolblocked", dc);
  assert.equal(poolblocked.policyConflict, false);
  assert.equal(poolblocked.selected, null);
  assert.equal(poolblocked.candidates.length, 0);
  assert.equal(poolblocked.checkRows[0].id, "pool-eligibility");
  assert.ok(poolblocked.reason.includes(dc + "/AZ2 has no eligible critical-pool cluster"));
  assert.ok(poolblocked.clusters.filter(cluster => cluster.az === "AZ2" && cluster.pool === "critical").every(cluster => !cluster.eligible && cluster.health === "unavailable"));
  assert.ok(poolblocked.clusters.filter(cluster => cluster.az === "AZ2" && cluster.pool === "standard").every(cluster => cluster.eligible && cluster.cpuFree >= 6 && cluster.memoryFree >= 24));
}
const mutable = getPlan("balanced", "DCE");
mutable.clusters[0].allowedCLs.push("CL3");
assert.deepEqual(getPlan("balanced", "DCE").clusters[0].allowedCLs, ["CL0", "CL1"]);
assert.deepEqual(getPlan("balanced", "DCE"), getPlan("balanced", "DCE"));
const browserContext = {};
vm.runInNewContext(fs.readFileSync(require.resolve("./placement-pools-model.js"), "utf8"), browserContext);
assert.equal(browserContext.PlacementPools.getPlan("balanced", "DCC").selected.dc, "DCC");
console.log("Placement pools model: all assertions passed for both explicitly selected datacenters.");
