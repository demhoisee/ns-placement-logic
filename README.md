# Namespace Placement Logic

Interactive walkthrough of OpenShift namespace placement, AZ affinity, quota allocation, capacity checks, and single-AZ failover.

Open `index.html` in a browser. Use **Play** or **Next** to follow placement; after a CL0/CL1 placement is ready, use the AZ-loss controls to simulate failover.

- Requested CPU/memory budget represents the whole application's 100% capacity.
- CL0/CL1 span three AZs in one datacenter: one-third normally runs in each AZ, with capacity protected for one-half in each.
- CL2–CL5 span two AZs. The example uses an illustrative equal split; their failover guarantee remains unspecified.
- Cluster capacities are illustrative, not live infrastructure data.

The supplied visualization is preserved byte-for-byte, including its sandboxed iframe and Content Security Policy.

## Placement controller logic

Use a **central placement controller** that approves the complete DC/AZ/cluster allocation before creating namespaces.

**Confirmed assumption:** the requested quota `Q` represents the application’s **100% compute capacity across its AZs**. For capacity calculations, express this as CPU and memory **requests**, with container limits sized separately.

The key CL0/CL1 rule is: **run one-third in each AZ, but protect capacity for one-half in each AZ.**

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

This requires **150% of full application demand across the three AZs**, before replica rounding and rollout overhead.

Each selected namespace needs quota permitting its **50% failure-mode allocation**, plus approved overhead. **ResourceQuota permits growth; it does not reserve physical capacity.** The placement controller must separately protect that headroom. [Kubernetes quota behavior](https://kubernetes.io/docs/concepts/policy/resource-quotas/).

The placement logic should follow these steps:

1. **Validate the request.** Read application identity, CL, full-load quota, pod sizes, DC restrictions, AZ affinity, dependencies and storage requirements. Identify AZs as `DCE/AZ2`, since `AZ2` exists in both DCs.

2. **Build eligible placements.** CL0/CL1 require all three AZs in one DC. CL2–CL5 require two AZs: evaluate AZ1+AZ2, AZ1+AZ3 and AZ2+AZ3. Initially, select one target cluster per required AZ.

3. **Apply affinity rules.**

   | Request | Placement behavior |
   |---|---|
   | No AZ preference | Evaluate every eligible DC and AZ combination |
   | Prefer DCE/AZ2 | Favor feasible placements satisfying that preference |
   | Must include DCE/AZ2 | CL0/CL1 use all three DCE AZs; CL2–CL5 choose a DCE pair containing AZ2 |
   | All instances must stay in AZ2 | Return a conflict with the multi-AZ requirement |

4. **Check capacity in every scenario.** Evaluate normal operation and each individual AZ failure. For every surviving target cluster, CPU and memory must independently satisfy:

   ```text
   Existing committed demand in that scenario
   + New application's demand in that scenario
   + Approved rollout overhead
   <= Usable cluster capacity
   ```

   Start from eligible workers’ **Node Allocatable**, accounting for platform pods and an operational buffer. Include unused capacity already promised to existing namespaces. Check that individual pods fit eligible nodes as well as checking cluster totals. Scheduling uses resource requests, so low observed utilization does not establish available capacity. [Node Allocatable](https://kubernetes.io/docs/tasks/administer-cluster/reserve-compute-resources/), [request-based scheduling](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/).

5. **Rank feasible plans.** Honor soft affinity, then favor the plan with the lowest worst-case CPU or memory utilization after placement. Spare capacity must exist in the actual selected clusters.

6. **Reserve and provision together.** Atomically record the entire placement reservation so concurrent requests cannot claim the same headroom. Create a namespace/project and its quota in each selected cluster, with RBAC, LimitRange and NetworkPolicy. Keep partially provisioned capacity charged until cleanup is confirmed. Namespaces are scoped to individual clusters. [Namespace scope](https://kubernetes.io/docs/concepts/overview/working-with-objects/namespaces/).

7. **Enforce the runtime plan.** On AZ failure, redirect traffic and scale the two surviving deployments toward 50% each. Required databases, services and storage must remain available to those survivors. Re-run admission when quotas, pod sizes or placement change.

For **CL2–CL5**, the two-AZ footprint is established; their normal split and failover guarantee still need a policy. If they must also preserve 100% after losing one AZ, **each selected AZ needs capacity for all of `Q`**, giving `2Q` total protected capacity.


