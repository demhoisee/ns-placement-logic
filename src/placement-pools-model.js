(function () {
  "use strict";

  // Illustrative, user-approved mapping; cluster names do not intrinsically define a pool.
  // gp1/ap1 are dedicated to CL0/CL1; gp2/ap2 are dedicated to CL2–CL5.
  const FULL_LOAD = Object.freeze({ cpu: 12, memory: 48 });
  const CRITICAL_CLS = ["CL0", "CL1"];
  const STANDARD_CLS = ["CL2", "CL3", "CL4", "CL5"];
  const scenarios = Object.freeze([
    Object.freeze({
      id: "balanced", label: "No AZ preference", cl: "CL0", affinity: "No AZ preference", dc: "DCE",
      description: "Compare eligible critical-pool cluster combinations within the selected datacenter; preserve three-AZ coverage."
    }),
    Object.freeze({
      id: "affinity", label: "Must include AZ2", cl: "CL1", affinity: "Must include selected DC/AZ2", dc: "DCE",
      description: "Choose one eligible critical-pool cluster in each selected-datacenter AZ, including the mandatory AZ2. Cluster names may differ between AZs."
    }),
    Object.freeze({
      id: "capacity", label: "Normal fits; failover does not", cl: "CL0", affinity: "Must include selected DC/AZ2", dc: "DCE",
      description: "Both critical-pool clusters in the selected datacenter's AZ2 have five free CPUs. Normal demand fits; the six-CPU failover ceiling does not. Standard-pool capacity cannot be substituted."
    }),
    Object.freeze({
      id: "exclusive", label: "Exclusive AZ conflicts", cl: "CL0", affinity: "Only selected DC/AZ2", dc: "DCE",
      description: "Exclusive single-AZ placement conflicts with the required three-AZ footprint."
    }),
    Object.freeze({
      id: "twoaz", label: "CL3 in its standard pool", cl: "CL3", affinity: "Must include selected DC/AZ2", dc: "DCE",
      description: "Illustrative 50/50 normal split across two standard-pool clusters in different AZs. No single-AZ failover guarantee has been assigned."
    }),
    Object.freeze({
      id: "poolblocked", label: "Eligible pool unavailable", cl: "CL0", affinity: "Must include selected DC/AZ2", dc: "DCE",
      description: "The selected datacenter's AZ2 has standard-pool capacity, but neither critical-pool cluster is eligible. The request cannot spill into the other pool."
    })
  ]);

  function buildClusters(scenarioId, selectedDC) {
    const clusters = [];
    ["DCE", "DCC"].forEach(function (dc) {
      ["AZ1", "AZ2", "AZ3"].forEach(function (az, azIndex) {
        const criticalFree = dc === "DCE" ? [[8, 7], [7, 8], [6, 7]][azIndex] :
          [[10, 9], [9, 8], [8, 7]][azIndex];
        ["gp1", "ap1", "gp2", "ap2"].forEach(function (name, nameIndex) {
          const pool = nameIndex < 2 ? "critical" : "standard";
          let cpuFree = pool === "critical" ? criticalFree[nameIndex] : name === "gp2" ? 10 : 8;
          let memoryFree = cpuFree * 4;
          let eligible = true;
          let health = "healthy";
          if (scenarioId === "capacity" && dc === selectedDC && az === "AZ2" && pool === "critical") {
            cpuFree = 5;
            memoryFree = 30;
          }
          if (scenarioId === "poolblocked" && dc === selectedDC && az === "AZ2" && pool === "critical") {
            eligible = false;
            health = "unavailable";
          }
          clusters.push({
            id: dc + "-" + az + "-" + name,
            name: name,
            dc: dc,
            az: az,
            pool: pool,
            allowedCLs: (pool === "critical" ? CRITICAL_CLS : STANDARD_CLS).slice(),
            cpuFree: cpuFree,
            memoryFree: memoryFree,
            cpuCapacity: 24,
            memoryCapacity: 96,
            eligible: eligible,
            health: health
          });
        });
      });
    });
    return clusters;
  }

  function scenarioCases(failoverSupported, normal, ceiling) {
    const cases = [{ id: "normal", label: "Normal operation", failedAZ: null, demand: normal }];
    if (failoverSupported) {
      ["AZ1", "AZ2", "AZ3"].forEach(function (az) {
        cases.push({ id: "loss-" + az, label: az + " lost", failedAZ: az, demand: ceiling });
      });
    }
    return cases;
  }

  function makeCandidate(targets, cases, ceiling) {
    const checks = [];
    cases.forEach(function (state) {
      targets.filter(function (cluster) { return cluster.az !== state.failedAZ; }).forEach(function (cluster) {
        [
          { key: "cpu", name: "CPU", free: cluster.cpuFree, unit: "CPU" },
          { key: "memory", name: "memory", free: cluster.memoryFree, unit: "GiB" }
        ].forEach(function (resource) {
          const needed = state.demand[resource.key];
          checks.push({
            id: state.id + ":" + cluster.id + ":" + resource.key,
            label: state.label + " · " + cluster.dc + "/" + cluster.az + "/" + cluster.name + " · " + resource.name,
            pass: needed <= resource.free,
            detail: "Needs " + needed + " " + resource.unit + "; " + resource.free + " " + resource.unit + " uncommitted."
          });
        });
      });
    });
    const utilizations = targets.map(function (cluster) {
      return Math.max(
        (cluster.cpuCapacity - cluster.cpuFree + ceiling.cpu) / cluster.cpuCapacity,
        (cluster.memoryCapacity - cluster.memoryFree + ceiling.memory) / cluster.memoryCapacity
      );
    });
    return {
      id: targets.map(function (cluster) { return cluster.id; }).join("+"),
      dc: targets[0].dc,
      clusterIds: targets.map(function (cluster) { return cluster.id; }),
      checks: checks,
      feasible: checks.every(function (check) { return check.pass; }),
      score: Math.max.apply(null, utilizations),
      // Resolve equal bottleneck scores by preferring individually roomier targets, then stable ID.
      totalUtilization: utilizations.reduce(function (sum, value) { return sum + value; }, 0)
    };
  }

  function combinations(groups) {
    return groups.reduce(function (plans, choices) {
      const expanded = [];
      plans.forEach(function (plan) {
        choices.forEach(function (cluster) { expanded.push(plan.concat([cluster])); });
      });
      return expanded;
    }, [[]]);
  }

  function summarize(candidate, cases, clusters) {
    if (!candidate) return [];
    return cases.map(function (state) {
      const checks = candidate.checks.filter(function (check) { return check.id.indexOf(state.id + ":") === 0; });
      const failed = checks.filter(function (check) { return !check.pass; });
      const targets = clusters.filter(function (cluster) {
        return candidate.clusterIds.indexOf(cluster.id) !== -1 && cluster.az !== state.failedAZ;
      });
      return {
        id: state.id,
        label: state.label,
        pass: checks.length > 0 && checks.every(function (check) { return check.pass; }),
        detail: failed.length ? failed.map(function (check) { return check.label + ": " + check.detail; }).join(" ") :
          targets.map(function (cluster) { return cluster.dc + "/" + cluster.az + "/" + cluster.name; }).join(", ") +
          " each fit " + state.demand.cpu + " CPU / " + state.demand.memory + " GiB."
      };
    });
  }

  // The UI must select a DC explicitly. DCE is the backward-compatible call default only.
  function getPlan(scenarioId, datacenter = "DCE") {
    if (datacenter !== "DCE" && datacenter !== "DCC") throw new RangeError("Datacenter must be DCE or DCC.");
    const source = scenarios.find(function (item) { return item.id === scenarioId; });
    if (!source) throw new RangeError("Unknown placement scenario: " + scenarioId);
    const scenario = Object.assign({}, source, {
      dc: datacenter,
      affinity: scenarioId === "balanced" ? "No AZ preference" :
        (scenarioId === "exclusive" ? "Only " : "Must include ") + datacenter + "/AZ2"
    });
    const inventory = buildClusters(scenarioId, datacenter);
    const clusters = inventory.filter(function (cluster) { return cluster.dc === datacenter; });
    const failoverSupported = CRITICAL_CLS.indexOf(scenario.cl) !== -1;
    const requiredPool = failoverSupported ? "critical" : "standard";
    const requiredAZCount = failoverSupported ? 3 : 2;
    const normal = failoverSupported ? { cpu: FULL_LOAD.cpu / 3, memory: FULL_LOAD.memory / 3 } :
      { cpu: FULL_LOAD.cpu / 2, memory: FULL_LOAD.memory / 2 };
    const ceiling = { cpu: FULL_LOAD.cpu / 2, memory: FULL_LOAD.memory / 2 };
    const cases = scenarioCases(failoverSupported, normal, ceiling);
    const candidates = [];
    const unavailableAZs = [];
    let policyConflict = false;
    let reason = "";

    if (scenarioId === "exclusive") {
      policyConflict = true;
      reason = "Only " + datacenter + "/AZ2 is allowed by this request, but CL0 requires three AZs within the selected datacenter.";
    } else {
      const dcs = [datacenter];
      const azSets = failoverSupported ? [["AZ1", "AZ2", "AZ3"]] : [["AZ1", "AZ2"], ["AZ2", "AZ3"]];
      dcs.forEach(function (dc) {
        azSets.forEach(function (azSet) {
          const choices = azSet.map(function (az) {
            const eligible = clusters.filter(function (cluster) {
              return cluster.dc === dc && cluster.az === az && cluster.pool === requiredPool &&
                cluster.allowedCLs.indexOf(scenario.cl) !== -1 && cluster.eligible && cluster.health === "healthy";
            });
            if (!eligible.length && unavailableAZs.indexOf(dc + "/" + az) === -1) unavailableAZs.push(dc + "/" + az);
            return eligible;
          });
          combinations(choices).forEach(function (targets) { candidates.push(makeCandidate(targets, cases, ceiling)); });
        });
      });
    }

    candidates.sort(function (left, right) {
      return left.score - right.score || left.totalUtilization - right.totalUtilization ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    });
    const selected = candidates.find(function (candidate) { return candidate.feasible; }) || null;
    if (selected) {
      reason = scenarioId === "twoaz" ?
        "Choose " + datacenter + "/AZ1/gp2 + " + datacenter + "/AZ2/gp2 from the standard pool. The illustrative 50/50 normal split fits; no AZ-loss survival guarantee is assigned." :
        "Choose " + selected.dc + " with one critical-pool cluster in each AZ. Normal one-third demand and every single-AZ-loss half-load scenario fit.";
    } else if (!policyConflict && unavailableAZs.length) {
      reason = unavailableAZs.join(", ") + " has no eligible " + requiredPool + "-pool cluster for " + scenario.cl +
        ". Available capacity in the other pool is not eligible; placement remains unassigned.";
    } else if (!policyConflict) {
      reason = "Selected " + datacenter + " placement is not feasible: both critical-pool clusters in " + datacenter + "/AZ2 need 6 CPU during loss of AZ1 or AZ3, but each has only 5 CPU uncommitted. Their normal 4-CPU share fits; standard-pool headroom cannot be substituted.";
    }

    let checkRows;
    if (policyConflict) checkRows = [{ id: "policy-conflict", label: "Multi-AZ policy", pass: false, detail: reason }];
    else if (!candidates.length) checkRows = [{ id: "pool-eligibility", label: "Eligible pool coverage", pass: false, detail: reason }];
    else checkRows = summarize(selected || candidates[0], cases, clusters);

    return {
      scenario: scenario,
      datacenter: datacenter,
      inventoryCount: inventory.length,
      clusters: clusters,
      candidates: candidates,
      selected: selected,
      reason: reason,
      policyConflict: policyConflict,
      normal: normal,
      ceiling: ceiling,
      checkRows: checkRows,
      failoverSupported: failoverSupported,
      requiredAZCount: requiredAZCount,
      requiredPool: requiredPool
    };
  }

  const api = { scenarios: scenarios, getPlan: getPlan };
  globalThis.PlacementPools = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
