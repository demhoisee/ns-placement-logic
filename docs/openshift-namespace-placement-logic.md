# OpenShift namespace placement, quota and capacity logic

Design baseline: November 4, 2026. This is a proposed policy, based on the described topology; no live cluster inventory was inspected.

## Confirmed requirements and assumptions

- DCE (East) and DCC (Central) each have AZ1, AZ2 and AZ3. OpenShift clusters are deployed within each AZ.
- **Each request must specify exactly one datacenter, DCE or DCC, before placement begins.** All AZ sets and cluster combinations are confined to that DC. There is no cross-region comparison or fallback; a missing/invalid DC returns a validation error.
- CL is treated as an application/deployment classification. CL0 and CL1 are highest criticality; criticality decreases toward CL5.
- CL0/CL1 applications span all three AZs within one selected datacenter.
- **User-confirmed CL0/CL1 operating rule: run at one-third of full application demand per AZ; reserve 50% in each selected cluster.** Normal aggregate demand is 100%, with 150% aggregate protected capacity before rounding and overhead.
- CL2–CL5 applications span two of the three AZs within the request's selected datacenter.
- **User-confirmed planning assumption: the incoming CPU/memory quota represents the whole application's 100% capacity, across its AZ deployments. It is not a quota per AZ.**
- For the initial policy, select one target cluster in each required AZ. A logical application namespace is realized as an independent namespace/project in every target cluster. Supporting several clusters per AZ requires a per-cluster allocation plan.
- Each AZ contains named clusters assigned to criticality pools. Filter by the cluster's configured criticality allowlist before checking capacity, then select the full combination of one eligible cluster per required AZ. Pool membership is a hard constraint, with no automatic cross-pool fallback.
- CL0/CL1 must support any one AZ loss, with the remaining two AZs providing 100% aggregate application capacity. A second simultaneous AZ loss and a datacenter loss are outside this stated requirement.
- CL2–CL5 failover capacity and normal traffic distribution have not yet been specified. Two-AZ placement by itself does not promise that the surviving AZ can serve 100%.

Namespaces are scoped to an individual cluster, so the application needs a corresponding namespace in each selected cluster. [Kubernetes namespaces](https://kubernetes.io/docs/concepts/overview/working-with-objects/namespaces/).

## Named clusters and criticality pools

The user approved this illustrative mapping:

| Pool | Example cluster names in each AZ | Allowed criticality levels |
| --- | --- | --- |
| Critical | `gp1`, `ap1` | CL0, CL1 |
| Standard | `gp2`, `ap2` | CL2, CL3, CL4, CL5 |

The mapping is configurable inventory, not verified production inventory. Each AZ may contain a different number of clusters. A name or prefix such as `gp` or `ap` has no implicit policy meaning; the cluster's explicit `allowed_criticalities` configuration is authoritative.

Use a fully qualified cluster ID, such as `DCE/AZ2/gp1`, because a short name can appear in more than one AZ or datacenter. Maintain at least the datacenter, AZ, short cluster name, pool, criticality allowlist, health, workload constraints and capacity commitments for every cluster.

The architecture's illustrative inventory contains 24 clusters in total: four named clusters in each of the six AZs. A single request is scoped to the selected DC's three AZs and 12 illustrative clusters. Inventory from the other DC is excluded before candidate generation and capacity evaluation.

For a CL0/CL1 application, first retain only Critical-pool clusters that allow that application's CL. Build all combinations of one such cluster in AZ1, one in AZ2 and one in AZ3 within the selected datacenter. Under the illustrative mapping, `gp1` and `ap1` are alternatives in each AZ; capacity checks determine which complete combination can be admitted.

For CL2–CL5, retain Standard-pool clusters that allow the requested CL, then build all eligible one-cluster-per-AZ combinations for each valid AZ pair. Spare capacity in an excluded pool does not make that pool eligible. An AZ with no cluster allowing the requested CL produces a pool eligibility mismatch, rather than a generic compute-capacity failure.

## Capacity and quota calculation

Let `Q = (CPU, memory)` be the total requested compute budget needed by the application at 100% designed load. Use aggregate pod **requests** at the intended replica count; keep container limits and their namespace quota ceilings as separately sized inputs. Calculate resource quantities from actual pod templates, including sidecars, effective init-container requests and pod overhead where applicable. For multiple components, calculate each component separately and then sum.

For CL0/CL1 with an even split, protect **50% of `Q` in every selected cluster**, while normal workloads use one-third:

```text
Normal demand per AZ                   = Q / 3
Demand per survivor after one AZ loss  = Q / 2
Additional failover headroom per AZ    = Q / 2 - Q / 3 = Q / 6
Total protected capacity across 3 AZs  = 3 * Q / 2 = 1.5 * Q
```

The 50% per-cluster reservation includes the normal one-third plus an additional one-sixth of full application demand for failover. The two surviving AZs each serve 50%, delivering 100% together. Each survivor grows by 50% relative to its own normal one-third share. The physical reservation is committed before the namespace placement is approved; it is not acquired for the first time during the outage.

| Scenario | AZ1 share | AZ2 share | AZ3 share | Application total |
| --- | ---: | ---: | ---: | ---: |
| Normal | 1/3 | 1/3 | 1/3 | 100% |
| AZ1 failed | 0 | 1/2 | 1/2 | 100% |
| AZ2 failed | 1/2 | 0 | 1/2 | 100% |
| AZ3 failed | 1/2 | 1/2 | 0 | 100% |

Example: an application requests a full-load budget of **12 CPU and 48 GiB**.

| Quantity in each target cluster | CPU | Memory |
| --- | ---: | ---: |
| Normal pod requests | 4 | 16 GiB |
| Protected failover ceiling | 6 | 24 GiB |
| Additional protected headroom | 2 | 8 GiB |

Set each namespace's `requests.cpu` / `requests.memory` quota to allow at least **6 CPU / 24 GiB**, plus explicitly calculated rollout or other approved overhead. Separately reserve that same protected compute capacity in the actual selected eligible cluster. Configure normal replica targets for **4 CPU / 16 GiB** and failure-mode targets for **6 CPU / 24 GiB**. Set pod-count quotas and container-limit quotas consistently so they do not block the planned failure-mode replicas. Define whether rollouts are permitted during an AZ outage; include their overlap in those scenarios if so. Keep old or terminating pods charged until their quota and capacity are actually released.

Quota is an admission ceiling; it does not reserve physical capacity. The platform must separately protect the failover capacity through its placement ledger and enforce growth decisions against that ledger. ResourceQuota can reject pod creation even though the Deployment object already exists. [Kubernetes resource quotas](https://kubernetes.io/docs/concepts/policy/resource-quotas/), [OpenShift project quotas](https://docs.redhat.com/en/documentation/openshift_container_platform/4.20/html/building_applications/quotas).

Use whole replica counts and scheduling-sized resource quantities rather than blindly multiplying a decimal by 33.33%. Small applications may require more than 150% protected capacity because of replica rounding or per-AZ fixed components. If total full-load replicas are not divisible by 3 or 2, calculate each concrete scenario. PVC size, data copies and shared services do not necessarily scale with compute percentages; evaluate them independently.

## Request inputs

At minimum, accept:

```text
application_id, environment, owner
criticality: CL0..CL5
full_load_budget: CPU requests, memory requests
pod_templates and full_load_replica_targets
datacenter: DCE | DCC  # required before planning
affinity:
  mode: none | preferAZ | mustIncludeAZ | onlyAZ
  datacenter: must match request.datacenter when an AZ is named
  zone: AZ1, AZ2 or AZ3
dependencies: required services, reachability and storage constraints
rollout_overhead and any additional resource/object quotas
```

Name zones with their datacenter, such as `DCE/AZ2`; `AZ2` alone is ambiguous.

Reject a missing or invalid `datacenter` before generating any candidate. A named AZ in the other DC is an affinity/datacenter conflict. The controller does not change the requested DC to satisfy an affinity or resolve a capacity shortage. No AZ preference means freedom to choose AZs within the already selected DC.

The controller also needs versioned cluster inventory and policy data:

```text
cluster_id: DCE/AZ2/gp1
datacenter: DCE
zone: AZ2
cluster_name: gp1
pool: critical
allowed_criticalities: [CL0, CL1]
health and workload_constraints
node_allocatable, platform_commitments, operational_buffer
existing_application_reservations_by_scenario
```

The application's CL determines which configured clusters are eligible. Applications do not bypass pool policy by naming a cluster or requesting an affinity.

## Affinity interpretation

| Request meaning | CL0/CL1 behavior | CL2–CL5 behavior |
| --- | --- | --- |
| No AZ preference | Evaluate all three AZs within the selected DC | Evaluate the AZ pairs 1+2, 1+3 and 2+3 within the selected DC |
| Prefer DCE/AZ2, with DCE selected | All three DCE AZs remain required; the preference cannot change the DC or even split | Prefer feasible DCE pairs that include AZ2 |
| Must include DCE/AZ2, with DCE selected | All three DCE AZs are required | DCE/AZ1+AZ2 or DCE/AZ2+AZ3 |
| Named AZ belongs to the other DC | Affinity/datacenter conflict; do not change DC | Affinity/datacenter conflict; do not change DC |
| All instances must run only in DCE/AZ2 | Policy conflict: cannot satisfy three-AZ placement | Policy conflict: cannot satisfy two-AZ placement |

An affinity request may mean a minimum footprint in the named AZ, a preferred traffic share, or strict exclusive placement. Record the intended meaning rather than inferring it from the word “affinity.” Under an even three-way CL0/CL1 policy, preferring AZ2 does not increase AZ2's normal share.

The requester selects the DC containing the required dependency before submitting the placement request. A database in AZ2 may justify including that AZ within the selected DC. The application can only survive AZ2 loss if its required database/service also remains available to the surviving deployments. Compute headroom cannot compensate for a lost dependency. Storage locality and network policies must permit each proposed normal and failover placement.

DC/AZ affinity and cluster-pool eligibility both apply. For example, `mustIncludeAZ=DCE/AZ2` requires a target in that AZ, and a CL1 request must still select an allowed Critical-pool cluster there. If no such cluster exists or has sufficient capacity, return the corresponding mismatch or shortfall instead of choosing a Standard-pool cluster.

## Cluster capacity model

For each candidate cluster `c`, maintain a resource vector:

```text
C[c] = sum(Node Allocatable on healthy, eligible worker nodes)
       - platform/DaemonSet pod commitments on those nodes
       - operational safety buffer
```

Node Allocatable already accounts for configured node-level OS/Kubernetes reservations; do not subtract those twice. Pod-based platform workloads still consume allocatable capacity and must be counted. Exclude nodes or pools that cannot run the workload because of taints, labels, architecture, GPUs, storage or other constraints. [Kubernetes Node Allocatable](https://kubernetes.io/docs/tasks/administer-cluster/reserve-compute-resources/).

Do not substitute observed CPU/memory utilization for committed capacity. Low utilization does not mean already allocated requests or promised namespace growth are available for another guaranteed reservation. Kubernetes scheduling is based on resource requests and checks fit on individual nodes. [Kubernetes resource management](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/).

Record `E[c, s]`, the existing committed application demand on cluster `c` in scenario `s`. Include dormant guaranteed allocations, approved growth and previously accepted requests that have not yet deployed. Avoid adding the same running pods and their covering reservation twice.

For a new candidate plan, calculate `N[c, s]`, its incremental demand in each scenario. Admit only when, for **every resource dimension**, every surviving target cluster and every supported scenario:

```text
E[c, s] + N[c, s] + approved_overlap_overhead[c, s] <= C[c]
```

For CL0/CL1, evaluate these scenarios only within `dc = request.datacenter`:

```text
normal
dc/AZ1 failed
dc/AZ2 failed
dc/AZ3 failed
```

In each failed-AZ scenario, treat every cluster in that AZ as unavailable and calculate all affected applications' growth together. Existing apps in unaffected AZs retain their promised demand. Test CPU and memory separately; abundant CPU cannot compensate for insufficient memory. Then verify actual pod-to-node fit, not just the cluster sum.

Spare capacity in some other cluster in the same AZ does not help an already placed namespace unless a supported migration or additional-cluster deployment path exists. Charge reservations to the actual selected cluster. Capacity in a cluster outside the application's criticality allowlist cannot satisfy the reservation, even if it is in the required AZ.

For each cluster, protect its largest total scenario demand. Do not sum mutually exclusive AZ-failure scenarios; do not let several applications independently claim the same headroom in the same scenario. The policy initially assumes no reclaiming or eviction of CL2–CL5 to make CL0/CL1 fit.

## Placement and creation algorithm

```text
place(request):
    if request.datacenter is missing or not one of [DCE, DCC]:
        return datacenter_required_or_invalid
    dc = request.datacenter
    if a named affinity AZ belongs to a different datacenter:
        return affinity_datacenter_conflict
    validate identity, CL, Q, pod shapes and AZ affinity semantics
    load versioned cluster inventory and criticality-pool policy
    determine required AZ count: CL0/1 -> 3; CL2..5 -> 2
    reject affinity constraints incompatible with that AZ count

    plans = []
    for az_set in valid_az_sets(request, dc):
        eligible_by_az = filter_clusters_in_each_az(
            dc, az_set, allowed_criticalities_contains=request.CL)
        if any required AZ has no policy-eligible cluster:
            record pool_eligibility_mismatch for that AZ and requested CL
            continue
        for targets in all_combinations(one_per_az=eligible_by_az):
            if health, policy, dependency or storage checks fail:
                continue
            allocation = calculate_normal_and_failure_allocations(request, targets)
            # CL0/1: normal Q/3, protected ceiling Q/2 per target
            if any supported scenario exceeds a cluster's committed capacity:
                record capacity_shortfall with cluster, scenario and resource
                continue
            if any required quota or pod-to-node fit check fails:
                continue
            plans.append(allocation)

    if no plans:
        return deferred_or_rejected_for_requested_dc_with_specific_reasons

    rank feasible plans by:
        1. requested soft affinity
        2. lowest worst-case post-placement CPU-or-memory utilization
        3. least harmful pod/resource fragmentation
        4. stable deterministic cluster-ID tie-break

    selected = first ranked plan
    atomically recheck inventory/policy versions and reserve selected plan in ledger
    if concurrent admission changed capacity or eligibility:
        retry candidate evaluation

    idempotently create/configure namespaces in all selected clusters
    apply ResourceQuota, LimitRange, RBAC and NetworkPolicy
    record selected cluster IDs/pools, CL, normal and failover replica ceilings
    verify every target is ready; then publish application placement as ready

    on partial failure:
        mark provisioning incomplete and reconcile/retry
        keep capacity charged wherever resources may still exist
        release capacity only after confirmed cleanup or safe rollback
```

The ledger reservation must cover the complete placement, not independently approve one AZ at a time. Cluster APIs are independent; cross-cluster namespace creation is a reconciled operation rather than a single Kubernetes transaction.

Re-run admission when an application's quota, pod shape, replica target, CL or placement changes. Reconcile commitments when cluster allocatable capacity, pool membership or criticality allowlists change; capacity loss or lost eligibility can invalidate earlier guarantees and must be reported rather than hidden by the original approval. A policy change does not authorize an automatic move into a different pool.

For scoring, `worst-case utilization` means the maximum of CPU and memory commitment/capacity across the selected surviving clusters and scenarios within the requested DC. Mandatory affinity, criticality-pool eligibility and capacity are eligibility rules; an attractive score never overrides them. A capacity or pool shortfall returns a result for that DC and never triggers planning in the other region.

Return a concrete plan containing selected DC, AZs, fully qualified cluster IDs, cluster pools, namespace names, per-cluster quota, normal/failure allocations, ledger reservation ID and any limiting resource. Return distinct reasons when a plan cannot be admitted:

- `pool_eligibility_mismatch`: for example, `DCE/AZ2 has no cluster allowing CL1 in the configured Critical pool`.
- `capacity_shortfall`: for example, `DCE/AZ2/gp1 is eligible for CL1 but lacks 2 CPU during DCE/AZ1 failure`.
- `datacenter_required_or_invalid`: the request does not specify DCE or DCC; no planning begins.
- `affinity_datacenter_conflict`: for example, the request selects DCC but names DCE/AZ2; the request remains scoped to DCC.
- `affinity_policy_conflict`, or a specific health, dependency, storage or pod-fit failure when applicable.

Do not report an ineligible cluster's free capacity as an alternative that can satisfy the request.

## Runtime behavior needed to realize the guarantee

During a failure, remove the failed AZ from application routing, scale the two surviving deployments to their approved half-load targets, and rebalance routing toward the survivors as they become ready. Reconcile toward the one-third split after recovery. Pre-approved quotas and protected existing worker capacity avoid having to acquire the whole reservation during the incident.

HPA can scale an individual workload from metrics; it does not by itself implement the cross-cluster placement and routing policy proposed here. Coordinate the cluster-local autoscaling targets with the failover controller so they do not conflict. [Kubernetes horizontal pod autoscaling](https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/).

The capacity calculation promises room to restore the full application workload after scaling; it does not establish zero interruption. Define the required recovery time, workload startup time, routing behavior and dependency recovery. Do not count future worker autoscaling as immediate failover capacity unless its tested recovery time satisfies that requirement.

## Decisions still needed

1. CL2–CL5: normal traffic split and whether an AZ loss must preserve full application capacity, partial service or only recoverability. With equal normal shares and a full surviving-AZ guarantee, each of the two AZs would need `Q`, for `2Q` protected compute in total.
2. For AZ-aware requests, whether the named AZ is preferred, mandatory to include, or exclusive; and whether the dependency itself survives that AZ's failure.
3. Required recovery time, rollout concurrency/overhead, and the operational buffer for each cluster.
4. Exact resource dimensions beyond CPU/memory and the constraints needed for pod-to-node fit.
5. The production inventory, number of clusters in each AZ and the final pool/criticality allowlists. The `gp1`/`ap1` and `gp2`/`ap2` mapping above is the user-approved illustrative example.

The confirmed CL0/CL1 admission policy is therefore: **the request's required DC, three AZs within that DC, one criticality-eligible cluster per AZ, normally one-third in each, protected 50% capacity in each, with all single-AZ-loss scenarios passing before namespace creation is approved.**
