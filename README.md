# Namespace Placement Logic

Interactive walkthrough of OpenShift namespace placement, AZ affinity, quota allocation, capacity checks, and single-AZ failover.

Open `index.html` in a browser. Select **DCE** or **DCC** for the request, then use **Play** or **Next** to follow placement; after a CL0/CL1 placement is ready, use the AZ-loss controls to simulate failover.

- Every request must specify exactly one datacenter: **DCE or DCC**. Placement evaluates only that DC; it does not compare regions or fall back to the other DC.
- Requested CPU/memory budget represents the whole application's 100% capacity.
- CL0/CL1 span three AZs in one datacenter: **run at one-third; reserve 50% in each AZ**. The reservation remains available for a single-AZ failure.
- CL2–CL5 span two AZs. The example uses an illustrative equal split; their failover guarantee remains unspecified.
- Every AZ contains named clusters. Criticality eligibility is checked before capacity; requests cannot spill into a different criticality pool.
- Cluster capacities are illustrative, not live infrastructure data.

The visualization retains its sandboxed iframe and Content Security Policy.

## Cluster pool legend

The user-approved illustrative mapping is:

| Pool | Example cluster names in each AZ | Eligible applications |
|---|---|---|
| Critical | `gp1`, `ap1` | CL0 and CL1 only |
| Standard | `gp2`, `ap2` | CL2 through CL5 only |

This is configurable inventory, not a claim about the deployed cluster names or count. Cluster names may repeat across datacenters and AZs, so use fully qualified IDs such as `DCE/AZ2/gp1`. A cluster's configured criticality allowlist determines eligibility; its name or prefix does not grant access.

Apply the pool rule as a **hard filter before checking capacity**. A CL0 request can select `gp1` or `ap1` in each required AZ under this mapping. It cannot select `gp2` or `ap2`, even when those clusters have more free capacity. CL2–CL5 requests follow the Standard pool rule. One eligible cluster is selected per required AZ, and all eligible cluster combinations are considered together.

## Placement controller logic

Use a **central placement controller** that approves the complete AZ/cluster allocation within the request's required datacenter before creating namespaces.

**Confirmed assumption:** the requested quota `Q` represents the application’s **100% compute capacity across its AZs**. For capacity calculations, express this as CPU and memory **requests**, with container limits sized separately.

The key CL0/CL1 rule is: **run one-third in each AZ; reserve 50% of full application demand in each selected cluster.** The 50% reservation covers the normal one-third plus additional failover headroom. It is protected physical capacity as well as a permitted namespace quota ceiling.

The running workload is distributed as follows:

| Scenario | AZ1 | AZ2 | AZ3 | Total |
|---|---:|---:|---:|---:|
| Normal | 33⅓% | 33⅓% | 33⅓% | 100% |
| AZ1 fails | — | 50% | 50% | 100% |
| AZ2 fails | 50% | — | 50% | 100% |
| AZ3 fails | 50% | 50% | — | 100% |

For example, if `Q = 12 CPU / 48 GiB`:

- Normal allocation in each AZ: **4 CPU / 16 GiB**.
- Protected capacity in each AZ: **6 CPU / 24 GiB**.
- Additional failover headroom in each AZ: **2 CPU / 8 GiB**.

This requires **150% of full application demand reserved across the three AZs**, before replica rounding and rollout overhead. Normal running demand totals 100%. When one AZ fails, its two survivors grow from one-third to one-half each and restore 100% together.

Each selected namespace needs quota permitting its **50% failure-mode allocation**, plus approved overhead. **ResourceQuota permits growth; it does not reserve physical capacity.** The placement controller must separately protect that headroom. [Kubernetes quota behavior](https://kubernetes.io/docs/concepts/policy/resource-quotas/).

The placement logic should follow these steps:

1. **Validate the request.** Require `datacenter = DCE` or `datacenter = DCC` before planning; return a missing/invalid-DC error otherwise. Read application identity, CL, full-load quota, pod sizes, AZ affinity, dependencies and storage requirements. Identify AZs as `DCE/AZ2`, since `AZ2` exists in both DCs. A named AZ must belong to the selected DC; a mismatch returns a conflict without changing the request's DC. Load each cluster's fully qualified ID, pool and allowed criticality levels from that DC's inventory.

2. **Build eligible placements.** Within the selected DC, CL0/CL1 require all three AZs. CL2–CL5 require two AZs: evaluate AZ1+AZ2, AZ1+AZ3 and AZ2+AZ3. Filter the named clusters in each AZ by the request's criticality allowlist before checking capacity. Evaluate all combinations of one eligible target cluster per required AZ; select the complete plan jointly. There is no fallback to another DC or across the Critical and Standard pools.

3. **Apply affinity rules.**

   | Request | Placement behavior |
   |---|---|
   | No AZ preference | Evaluate eligible AZ combinations only within the selected DC |
   | Prefer DCE/AZ2, with DCE selected | Favor feasible DCE placements satisfying that preference |
   | Must include DCE/AZ2, with DCE selected | CL0/CL1 use all three DCE AZs; CL2–CL5 choose a DCE pair containing AZ2 |
   | Named AZ belongs to the other DC | Return a DC/affinity conflict; retain the selected DC |
   | All instances must stay in AZ2 | Return a conflict with the multi-AZ requirement |

4. **Check capacity in every scenario.** For CL0/CL1, evaluate normal operation and each individual AZ failure, protecting **50% of `Q` in each selected cluster**. For CL2–CL5, evaluate the declared normal split and any separately approved failover policy. For every surviving target cluster, CPU and memory must independently satisfy:

   ```text
   Existing committed demand in that scenario
   + New application's demand in that scenario
   + Approved rollout overhead
   <= Usable cluster capacity
   ```

   Start from eligible workers’ **Node Allocatable**, accounting for platform pods and an operational buffer. Include unused capacity already promised to existing namespaces. Check that individual pods fit eligible nodes as well as checking cluster totals. Capacity in a different cluster or an ineligible pool cannot satisfy this target's reservation. Scheduling uses resource requests, so low observed utilization does not establish available capacity. [Node Allocatable](https://kubernetes.io/docs/tasks/administer-cluster/reserve-compute-resources/), [request-based scheduling](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/).

5. **Rank feasible plans within the selected DC.** Honor soft AZ affinity, then favor the plan with the lowest worst-case CPU or memory utilization after placement. Spare capacity must exist in the actual selected eligible clusters. If no plan fits, distinguish a **pool eligibility mismatch** from a **capacity shortfall**, and name the affected DC/AZ/cluster or missing eligible pool. Return the result for that DC; do not retry placement in the other region.

6. **Reserve and provision together.** Atomically record the entire placement reservation so concurrent requests cannot claim the same headroom. Create a namespace/project and its quota in each selected cluster, with RBAC, LimitRange and NetworkPolicy. Keep partially provisioned capacity charged until cleanup is confirmed. Namespaces are scoped to individual clusters. [Namespace scope](https://kubernetes.io/docs/concepts/overview/working-with-objects/namespaces/).

7. **Enforce the runtime plan.** On AZ failure, redirect traffic and scale the two surviving deployments toward 50% each using their already protected capacity. Required databases, services and storage must remain available to those survivors. Re-run admission when quotas, pod sizes, placement or cluster-pool eligibility change.

For **CL2–CL5**, the two-AZ footprint is established; their normal split and failover guarantee still need a policy. If they must also preserve 100% after losing one AZ, **each selected AZ needs capacity for all of `Q`**, giving `2Q` total protected capacity.

The [detailed placement design](docs/openshift-namespace-placement-logic.md) includes the capacity model, request schema, cluster-pool rules and provisioning pseudocode.

## Planner example

The full illustrative architecture contains 24 clusters: `gp1`, `ap1`, `gp2` and `ap2` in each of the six AZs. A request selects one DC, so the wireframe displays that DC's **12 clusters** and plans within its three AZs. It demonstrates no AZ preference within the selected DC, required AZ affinity, a failover capacity shortfall, an exclusive-AZ conflict, Standard-pool placement and an unavailable Critical pool.

The dependency-free [demonstration model](src/placement-pools-model.js) evaluates these request fixtures with `getPlan(scenarioId, datacenter = 'DCE')`. The API's DCE default is a demonstration convenience; production requests must supply their DC. Each call evaluates only the supplied DC, checks explicit pool eligibility, enumerates eligible cluster combinations and tests CPU and memory in each supported failure scenario. It is an example of the proposed selection logic; production inventory collection, reservation enforcement and namespace provisioning still require the controller described above.

The demo ranks feasible plans by their worst-case utilization, then lower aggregate target utilization, then stable cluster IDs. The detailed production design also allows fragmentation-aware tie-breaking; pool and capacity rules always apply first.

Run its checks with Node.js:

```sh
node src/placement-pools-model.test.js
```


