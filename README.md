# Namespace Placement Logic

Interactive walkthrough of OpenShift namespace placement, AZ affinity, quota allocation, capacity checks, and single-AZ failover.

Open `index.html` in a browser. Use **Play** or **Next** to follow placement; after a CL0/CL1 placement is ready, use the AZ-loss controls to simulate failover.

- Requested CPU/memory budget represents the whole application's 100% capacity.
- CL0/CL1 span three AZs in one datacenter: one-third normally runs in each AZ, with capacity protected for one-half in each.
- CL2–CL5 span two AZs. The example uses an illustrative equal split; their failover guarantee remains unspecified.
- Cluster capacities are illustrative, not live infrastructure data.

The supplied visualization is preserved byte-for-byte, including its sandboxed iframe and Content Security Policy.
