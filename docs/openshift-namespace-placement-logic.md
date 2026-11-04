# OpenShift namespace placement, quota and capacity logic

Design baseline: November 4, 2026. This is a proposed policy, based on the described topology; no live cluster inventory was inspected.

## Confirmed requirements and assumptions

- DCE (East) and DCC (Central) each have AZ1, AZ2 and AZ3. OpenShift clusters are deployed within each AZ.
- CL is treated as an application/deployment classification. CL0 and CL1 are highest criticality; criticality decreases toward CL5.
- CL0/CL1 applications span all three AZs within one selected datacenter.
- CL2–CL5 applications span two of the three AZs. The two AZs are assumed to belong to one datacenter.
- **User-confirmed planning assumption: the incoming CPU/memory quota represents the whole application's 100% capacity, across its AZ deployments. It is not a quota per AZ.**
- For the initial policy, select one target cluster in each required AZ. A logical application namespace is realized as an independent namespace/project in every target cluster. Supporting several clusters per AZ requires a per-cluster allocation plan.
- CL0/CL1 must support any one AZ loss, with the remaining two AZs providing 100% aggregate application capacity. A second simultaneous AZ loss and a datacenter loss are outside this stated requirement.
- CL2–CL5 failover capacity and normal traffic distribution have not yet been specified. Two-AZ placement by itself does not promise that the surviving AZ can serve 100%.

Namespaces are scoped to an individual cluster, so the application needs a corresponding namespace in each selected cluster. [Kubernetes namespaces](https://kubernetes.io/docs/concepts/overview/working-with-objects/namespaces/).

## Capacity and quota calculation

Let `Q = (CPU, memory)` be the total requested compute budget needed by the application at 100% designed load. Use aggregate pod **requests** at the intended replica count; keep container limits and their namespace quota ceilings as separately sized inputs. Calculate resource quantities from actual pod templates, including sidecars, effective init-container requests and pod overhead where applicable. For multiple components, calculate each component separately and then sum.

For CL0/CL1 with an even split:

```text
Normal demand per AZ                   = Q / 3
Demand per survivor after one AZ loss  = Q / 2
Additional failover headroom per AZ    = Q / 2 - Q / 3 = Q / 6
Total protected capacity across 3 AZs  = 3 * Q / 2 = 1.5 * Q
```

The two surviving AZs each serve 50%, delivering 100% together. Each survivor grows by 50% relative to its own normal one-third share.

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

Set each namespace's `requests.cpu` / `requests.memory` quota to allow at least **6 CPU / 24 GiB**, plus explicitly calculated rollout or other approved overhead. Configure normal replica targets for **4 CPU / 16 GiB** and failure-mode targets for **6 CPU / 24 GiB**. Set pod-count quotas and container-limit quotas consistently so they do not block the planned failure-mode replicas. Define whether rollouts are permitted during an AZ outage; include their overlap in those scenarios if so. Keep old or terminating pods charged until their quota and capacity are actually released.

Quota is an admission ceiling; it does not reserve physical capacity. The platform must separately protect the failover capacity through its placement ledger and enforce growth decisions against that ledger. ResourceQuota can reject pod creation even though the Deployment object already exists. [Kubernetes resource quotas](https://kubernetes.io/docs/concepts/policy/resource-quotas/), [OpenShift project quotas](https://docs.redhat.com/en/documentation/openshift_container_platform/4.20/html/building_applications/quotas).

Use whole replica counts and scheduling-sized resource quantities rather than blindly multiplying a decimal by 33.33%. Small applications may require more than 150% protected capacity because of replica rounding or per-AZ fixed components. If total full-load replicas are not divisible by 3 or 2, calculate each concrete scenario. PVC size, data copies and shared services do not necessarily scale with compute percentages; evaluate them independently.

## Request inputs

At minimum, accept:

```text
application_id, environment, owner
criticality: CL0..CL5
full_load_budget: CPU requests, memory requests
pod_templates and full_load_replica_targets
datacenter: required, preferred, or unrestricted
affinity:
  mode: none | preferAZ | mustIncludeAZ | onlyAZ
  datacenter: DCE or DCC, when an AZ is named
  zone: AZ1, AZ2 or AZ3
dependencies: required services, reachability and storage constraints
rollout_overhead and any additional resource/object quotas
```

Name zones with their datacenter, such as `DCE/AZ2`; `AZ2` alone is ambiguous.

## Affinity interpretation

| Request meaning | CL0/CL1 behavior | CL2–CL5 behavior |
| --- | --- | --- |
| No AZ preference | Evaluate all three AZs in each eligible DC | Evaluate the AZ pairs 1+2, 1+3 and 2+3 in each eligible DC |
| Prefer DCE/AZ2 | Prefer DCE when otherwise feasible; all three AZs remain required | Prefer feasible pairs that include DCE/AZ2 |
| Must include DCE/AZ2 | DCE and all three AZs are required | DCE/AZ1+AZ2 or DCE/AZ2+AZ3 |
| All instances must run only in DCE/AZ2 | Policy conflict: cannot satisfy three-AZ placement | Policy conflict: cannot satisfy two-AZ placement |

An affinity request may mean a minimum footprint in the named AZ, a preferred traffic share, or strict exclusive placement. Record the intended meaning rather than inferring it from the word “affinity.” Under an even three-way CL0/CL1 policy, preferring AZ2 does not increase AZ2's normal share.

A database in AZ2 may justify selecting that DC or including that AZ. The application can only survive AZ2 loss if its required database/service also remains available to the surviving deployments. Compute headroom cannot compensate for a lost dependency. Storage locality and network policies must permit each proposed normal and failover placement.

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

The initial scenario set is:

```text
normal
DCE/AZ1 failed, DCE/AZ2 failed, DCE/AZ3 failed   (for a DCE plan)
or
DCC/AZ1 failed, DCC/AZ2 failed, DCC/AZ3 failed   (for a DCC plan)
```

In each failed-AZ scenario, treat every cluster in that AZ as unavailable and calculate all affected applications' growth together. Existing apps in unaffected AZs retain their promised demand. Test CPU and memory separately; abundant CPU cannot compensate for insufficient memory. Then verify actual pod-to-node fit, not just the cluster sum.

Spare capacity in some other cluster in the same AZ does not help an already placed namespace unless a supported migration or additional-cluster deployment path exists. Charge reservations to the actual selected cluster.

For each cluster, protect its largest total scenario demand. Do not sum mutually exclusive AZ-failure scenarios; do not let several applications independently claim the same headroom in the same scenario. The policy initially assumes no reclaiming or eviction of CL2–CL5 to make CL0/CL1 fit.

## Placement and creation algorithm

```text
place(request):
    validate identity, CL, Q, pod shapes, DC and affinity semantics
    determine required AZ count: CL0/1 -> 3; CL2..5 -> 2
    reject affinity constraints incompatible with that AZ count

    plans = []
    for dc in eligible_datacenters(request):
        for az_set in valid_az_sets(request, dc):
            for targets in candidate_cluster_combinations(one_per_az=az_set):
                if health, policy, dependency or storage checks fail:
                    continue
                allocation = calculate_normal_and_failure_allocations(request, targets)
                if any supported scenario exceeds a cluster's committed capacity:
                    continue
                if any required quota or pod-to-node fit check fails:
                    continue
                plans.append(allocation)

    if no plans:
        return deferred_or_rejected_with_specific_reasons

    rank feasible plans by:
        1. requested soft affinity
        2. lowest worst-case post-placement CPU-or-memory utilization
        3. least harmful pod/resource fragmentation
        4. stable deterministic cluster-ID tie-break

    selected = first ranked plan
    atomically recheck inventory version and reserve selected plan in ledger
    if concurrent admission changed capacity:
        retry candidate evaluation

    idempotently create/configure namespaces in all selected clusters
    apply ResourceQuota, LimitRange, RBAC and NetworkPolicy
    record normal and failover replica ceilings and placement metadata
    verify every target is ready; then publish application placement as ready

    on partial failure:
        mark provisioning incomplete and reconcile/retry
        keep capacity charged wherever resources may still exist
        release capacity only after confirmed cleanup or safe rollback
```

The ledger reservation must cover the complete placement, not independently approve one AZ at a time. Cluster APIs are independent; cross-cluster namespace creation is a reconciled operation rather than a single Kubernetes transaction.

Re-run admission when an application's quota, pod shape, replica target or placement changes. Reconcile commitments when cluster allocatable capacity or eligibility changes; capacity loss can invalidate earlier guarantees and must be reported rather than hidden by the original approval.

For scoring, `worst-case utilization` means the maximum of CPU and memory commitment/capacity across the selected surviving clusters and scenarios. Mandatory affinity and capacity are eligibility rules; an attractive score never overrides them. A request with a required DC or AZ cannot silently move to another DC if capacity is insufficient.

Return a concrete plan containing selected DC, AZs, cluster IDs, namespace names, per-cluster quota, normal/failure allocations, ledger reservation ID and any limiting resource. If rejected or deferred, return the failing AZ/cluster/scenario and shortfall, such as: `DCE/AZ2 target: missing 2 CPU during DCE/AZ1 failure`.

## Runtime behavior needed to realize the guarantee

During a failure, remove the failed AZ from application routing, scale the two surviving deployments to their approved half-load targets, and rebalance routing toward the survivors as they become ready. Reconcile toward the one-third split after recovery. Pre-approved quotas and protected existing worker capacity avoid having to acquire the whole reservation during the incident.

HPA can scale an individual workload from metrics; it does not by itself implement the cross-cluster placement and routing policy proposed here. Coordinate the cluster-local autoscaling targets with the failover controller so they do not conflict. [Kubernetes horizontal pod autoscaling](https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/).

The capacity calculation promises room to restore the full application workload after scaling; it does not establish zero interruption. Define the required recovery time, workload startup time, routing behavior and dependency recovery. Do not count future worker autoscaling as immediate failover capacity unless its tested recovery time satisfies that requirement.

## Decisions still needed

1. CL2–CL5: normal traffic split and whether an AZ loss must preserve full application capacity, partial service or only recoverability. With equal normal shares and a full surviving-AZ guarantee, each of the two AZs would need `Q`, for `2Q` protected compute in total.
2. For AZ-aware requests, whether the named AZ is preferred, mandatory to include, or exclusive; and whether the dependency itself survives that AZ's failure.
3. Required recovery time, rollout concurrency/overhead, and the operational buffer for each cluster/pool.
4. Exact resource dimensions beyond CPU/memory and the constraints needed for pod-to-node fit.

The confirmed CL0/CL1 admission policy is therefore: **one DC, three AZs, normally one-third in each, protected half-load capacity in each, with all single-AZ-loss scenarios passing before namespace creation is approved.**
