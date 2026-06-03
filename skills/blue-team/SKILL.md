---
name: blue-team
description: >
  Defensive security operations skill. Use when designing or improving a SOC, building detection engineering pipelines, conducting threat hunts, writing incident response playbooks, tuning SIEM/XDR/SOAR platforms, mapping defenses to MITRE ATT&CK, or responding to an active incident. Grounded in contemporary 2025–2026 research and frameworks.
---

# Blue Team Skill

Use this skill when the task involves **defensive security operations**: monitoring, detection engineering, threat hunting, incident response, or security control tuning. The goal is to detect adversaries earlier, respond faster, and continuously reduce dwell time.

---

## Background & Research Grounding (2025–2026)

Blue teaming has evolved from reactive SOC operations to a proactive, engineering-led discipline:

- **Detection engineering** is now treated as software engineering — detection rules live in version control, have tests, and deploy via CI/CD
- **TDIR (Threat Detection, Investigation, and Response)** is the unified model replacing fragmented SOC operations
- **XDR** (Extended Detection & Response) unifies endpoint, network, identity, and cloud signals in a single platform — replacing siloed EDR + SIEM stacks
- **AI/LLM integration** is active research: LLMs applied to log analysis, alert triage, IR ticket parsing, and detection rule authoring
- **Identity is the primary attack surface** in 2025: identity-related detections grew 5× YoY (Red Canary H1 2025)
- **Behaviour-based detection** is the most effective approach (2025 SANS/Anvilogic report) but requires threat modelling skills many teams lack
- **NSA/CISA SIEM+SOAR practitioner guidance** (May 2025) is the authoritative government implementation reference
- **Purple teaming** is the feedback loop that keeps detections current — blue teams must run structured ATT&CK validation sessions with red counterparts

---

## Workflow

### Step 1 — Understand the Environment

Before building or tuning defenses, map what you're protecting:

```
Asset inventory:      [Endpoints, servers, cloud workloads, SaaS, OT/IoT]
Identity plane:       [AD / Entra ID / Okta — where do credentials live?]
Data classification:  [What are the crown jewels? Where do they live?]
Current tooling:      [SIEM, EDR, NDR, XDR, SOAR, email gateway, firewall]
Log coverage:         [What is being collected? What are the gaps?]
Team structure:       [L1/L2/L3 analysts, detection engineers, threat hunters — who does what?]
Threat profile:       [What adversary types are most likely? Ransomware? Nation-state? Insider?]
```

### Step 2 — Log Coverage & Data Foundation

Detection is only as good as the data underneath it. Audit log coverage against this checklist:

| Source | Priority | Key Events |
|---|---|---|
| **Windows Event Logs** | Critical | 4624/4625 (logon), 4688 (process), 4698/4702 (scheduled tasks), 4720/4726 (user mgmt) |
| **Active Directory / Entra ID** | Critical | Privilege changes, MFA bypass, token abuse, service principal changes |
| **DNS** | High | Unusual domains, DGA patterns, tunnelling |
| **Network flows (NetFlow/IPFIX)** | High | Lateral movement, beaconing, exfiltration volumes |
| **Endpoint (EDR telemetry)** | Critical | Process creation, file writes, network connections, registry |
| **Cloud audit logs** | Critical | CloudTrail, Unified Audit Log, GCP Cloud Audit — API calls, IAM changes |
| **Email gateway** | High | Phishing, malicious attachments, sender spoofing |
| **Web proxy / DNS-over-HTTPS** | High | Suspicious outbound, C2 beaconing patterns |
| **Authentication (VPN, SSO, MFA)** | Critical | Failed logins, impossible travel, MFA fatigue patterns |

**Gap analysis**: for each missing source, assess risk and prioritise ingestion. Not every log needs to go into SIEM — route noise-heavy sources to cheap storage and pull on demand.

### Step 3 — Detection Engineering

Apply software engineering practices to detection rule development:

#### Detection Rule Lifecycle
```
1. Threat modelling → identify the behaviour to detect (ATT&CK technique)
2. Data exploration → find the log source and relevant fields
3. Rule authoring → write the detection (Sigma / KQL / SPL / YARA-L)
4. Testing → validate against known-good (no false positives) and known-bad (simulated via Atomic Red Team)
5. Peer review → second analyst reviews logic and field mappings
6. Deployment → merge to main branch, auto-deploy to SIEM/XDR
7. Tuning → monitor false positive rate; adjust threshold/exclusions
8. Retirement → when technique becomes obsolete or better rule exists
```

#### Detection Quality Tiers
| Tier | Type | Example |
|---|---|---|
| **T1 — IOC** | Hash / IP / domain exact match | Known malware hash blocklist |
| **T2 — Signature** | Pattern-based, slightly generalised | Specific command-line string |
| **T3 — Behavioural** | Activity patterns over time | Process spawning unusual child processes |
| **T4 — Anomaly** | Statistical baseline deviation | User accessing 10× normal data volume |

Aim to shift detection coverage toward T3/T4 — IOC-only detection is trivially bypassed.

#### Detection Rule Authoring Standards
- Write in **Sigma** (vendor-neutral) as the source of truth; compile to platform-specific syntax
- Include: title, description, ATT&CK technique reference, data sources, false positive guidance
- Tag every rule with the ATT&CK technique(s) it covers
- Maintain a test case alongside each rule (positive match, negative match)

```yaml
# Example Sigma rule structure
title: Suspicious LSASS Memory Access
status: stable
description: Detects tools accessing LSASS memory — common for credential dumping
references:
  - https://attack.mitre.org/techniques/T1003/001/
tags:
  - attack.credential_access
  - attack.t1003.001
logsource:
  category: process_access
  product: windows
detection:
  selection:
    TargetImage|endswith: '\lsass.exe'
    GrantedAccess|contains:
      - '0x1010'
      - '0x1410'
  condition: selection
falsepositives:
  - Legitimate security products (whitelist by process hash)
level: high
```

### Step 4 — SIEM / XDR Configuration

Follow NSA/CISA SIEM+SOAR practitioner guidance (May 2025) principles:

**SIEM architecture decisions:**
- Separate log collection/storage from SIEM visualisation (cost optimisation)
- Use dual log replication for high-value sources — redundancy against tampering
- Apply log retention tiers: hot (90 days SIEM), warm (1 year object storage), cold (7 years archive)
- Never ingest everything — triage log value vs cost; high-noise/low-signal logs go to storage, not SIEM

**Alert tuning process:**
```
New rule deployed → monitor false positive rate for 2 weeks
FP rate > 5%: add exclusions / raise threshold
FP rate = 0% but low coverage: expand scope / add data sources
True positive fires: follow IR playbook, document in case
```

**XDR considerations (2026 state-of-the-art):**
- XDR unifies EDR + NDR + cloud + identity — prefer over siloed point tools
- Agentic AI/autonomous response is emerging: validate before enabling auto-remediation
- Open XDR (e.g., Stellar Cyber) allows best-of-breed tool integration without vendor lock-in

### Step 5 — Threat Hunting

Threat hunting is analyst-led, hypothesis-driven search for threats that have evaded automated detection.

#### Hunting Process
```
1. Formulate hypothesis  [What adversary behaviour might be present that we're not detecting?]
2. Define hunt scope     [Time window, data sources, systems in scope]
3. Collect & explore     [Pull relevant logs, apply statistical analysis, visualise patterns]
4. Investigate anomalies [Dig into outliers — are they benign or adversarial?]
5. Document findings     [New IOC, new TTP, new detection rule, or confirmed clean]
6. Convert to detection  [Every confirmed hunt finding should become an automated detection]
```

#### Hunt Hypothesis Sources
- New MITRE ATT&CK techniques (review ATT&CK updates biannually)
- Recent threat intelligence (CTI feeds, ISAC reports, vendor advisories)
- Red team engagement findings (techniques that weren't detected)
- External incident reports (what worked against similar organisations)
- Internal anomalies (baseline deviation alerts that need investigation)

#### Top Hunt Frameworks (2025–2026)
| Framework | Approach |
|---|---|
| **OTHF** (Open Threat Hunting Framework) | Community-driven, flexible, focuses on activity pattern analysis |
| **Intel 471** | Intelligence-driven — start from threat actor TTPs, hunt backward |
| **MITRE ATT&CK Threat Hunting** | ATT&CK-mapped hunt hypotheses with data source requirements |
| **TaHiTI** | Structured hunt lifecycle management framework |

#### Living-off-the-Land (LotL) Detection

Modern attackers use native OS tools to avoid EDR detection. Priority hunt areas:

```
Windows:
- PowerShell with encoded commands (T1059.001)
- WMI subscriptions for persistence (T1546.003)
- certutil for payload download (T1105)
- mshta / regsvr32 / rundll32 proxy execution (T1218)
- Scheduled tasks created by unusual parents (T1053.005)

Linux/macOS:
- Cron/crontab modifications (T1053.003)
- Bash history clearing (T1070.003)
- Unusual SUID/SGID binaries (T1548.001)
- SSH authorised_keys modifications (T1098.004)

Cloud / Identity:
- Service principal secret additions (Entra ID)
- OAuth app consent grants (T1550.001)
- CloudTrail disabled or log validation modified (T1562.008)
- Unusual cross-region API calls
```

### Step 6 — Incident Response

Structured IR reduces dwell time and limits blast radius.

#### IR Phases (NIST SP 800-61)
```
1. Preparation     → Playbooks, runbooks, tooling, contacts, backups all ready before incident
2. Detection       → Alert fires or hunt finds anomaly
3. Analysis        → Triage: Is this a real incident? Scope? Severity?
4. Containment     → Short-term (isolate host) → long-term (block attacker path)
5. Eradication     → Remove attacker presence, close initial access vector
6. Recovery        → Restore systems; validate clean before reconnecting
7. Post-incident   → Root cause analysis, lessons learned, detection improvement
```

#### Severity Classification
| Severity | Criteria | Response SLA |
|---|---|---|
| **P1 — Critical** | Active breach, data exfiltration in progress, ransomware detonation | Immediate — 24/7 response |
| **P2 — High** | Confirmed intrusion, contained; lateral movement detected | < 4 hours |
| **P3 — Medium** | Suspicious activity, unconfirmed; single endpoint compromise | < 24 hours |
| **P4 — Low** | Policy violation, isolated phishing click, no payload execution | < 72 hours |

#### Incident Command Model
When P1/P2 is confirmed:
```
Incident Commander (IC): overall coordination, stakeholder comms
Technical Lead:           investigation and containment decisions
Communications Lead:      legal, PR, exec updates
Scribe:                   real-time timeline documentation (never the IC)
```

#### IR Playbook Template
For each threat scenario, maintain a playbook:
```markdown
# Playbook: [Threat Scenario Name]
ATT&CK Techniques: [T####.###, ...]
Trigger: [Alert name / hunt finding / external notification]

## Triage Checklist
- [ ] Confirm the alert is a true positive
- [ ] Identify affected systems and accounts
- [ ] Assess data accessed / exfiltrated

## Containment Steps
1. Isolate affected endpoint (network quarantine via EDR)
2. Revoke/rotate compromised credentials
3. Block attacker C2 IOCs at firewall/proxy

## Evidence Preservation
- [ ] Capture memory image before isolation (if warranted)
- [ ] Preserve EDR telemetry and SIEM alerts
- [ ] Collect relevant logs to IR case folder

## Eradication
1. Remove malware / persistence mechanisms
2. Patch/harden the initial access vector
3. Scan environment for lateral spread

## Recovery
1. Rebuild or restore affected systems from clean backup
2. Validate clean before reconnecting to network
3. Monitor closely for 72 hours post-recovery

## Post-Incident
- Root cause documented
- New detection rule created (if gap identified)
- Stakeholder report issued within [SLA]
```

### Step 7 — SOAR Automation

Automate repetitive, high-confidence IR actions to reduce analyst fatigue:

**Good SOAR automation candidates:**
- Phishing triage: auto-pull headers, check URLs/hashes against threat intel, quarantine email
- IP/domain enrichment: auto-query VirusTotal / Shodan / WHOIS on every IOC
- Account lockout on confirmed compromise: auto-disable via identity platform API
- Firewall block: auto-push block rule for confirmed malicious IPs
- Ticket creation and routing: auto-open case from alert, assign to on-call analyst

**Poor SOAR automation candidates** (require human judgment):
- Endpoint isolation for P3/P4 alerts (too many false positives)
- Mass password resets
- Any action affecting production systems without analyst verification

### Step 8 — Metrics & Continuous Improvement

Track these SOC health metrics:

| Metric | Target | Notes |
|---|---|---|
| **MTTD** (Mean Time to Detect) | Trend down | Time from attacker action to alert |
| **MTTR** (Mean Time to Respond) | Trend down | Time from alert to containment |
| **False Positive Rate** | < 5% per rule | Monitor per-rule; high FP = rule needs tuning |
| **Detection Coverage %** | Trend up | % of ATT&CK techniques with a detection |
| **Hunt findings rate** | Track | Hunts that result in new detections or confirmed threats |
| **Alert-to-case conversion** | Track | % of alerts that become confirmed incidents |
| **Dwell time** | Trend down | Time attacker is present before detection |

Run **quarterly ATT&CK coverage reviews**: use ATT&CK Navigator to visualise coverage gaps, then prioritise detection engineering work accordingly.

### Step 9 — Purple Team Feedback Loop

After every red team engagement (and at least quarterly):
1. Red provides timestamped TTP log to blue
2. Blue audits detection coverage against each action
3. For each missed detection: open a detection engineering ticket
4. New detection written, tested, deployed within sprint
5. Red re-runs the technique to validate detection fires
6. Document detection improvement in ATT&CK Navigator layer

---

## Tooling Reference (2025–2026)

### SIEM Platforms
- **Microsoft Sentinel** — cloud-native, Kusto (KQL), strong Entra ID integration
- **Splunk Enterprise Security** — industry leader, SPL, rich ecosystem
- **Elastic SIEM** — open-source core, EQL detection language
- **Chronicle (Google SecOps)** — petabyte-scale, YARA-L 2.0, built-in threat intel

### XDR Platforms
- **CrowdStrike Falcon XDR** — EDR-native, strong threat graph
- **Microsoft Defender XDR** — tightly integrated with M365 / Entra ID
- **SentinelOne Singularity XDR** — autonomous response capabilities
- **Stellar Cyber Open XDR** — vendor-agnostic; integrates any existing tool

### SOAR
- **Microsoft Sentinel Playbooks** (Logic Apps) — native to Sentinel
- **Splunk SOAR** (formerly Phantom) — mature, rich integrations
- **Palo Alto XSOAR** — enterprise SOAR with case management
- **Tines** — modern, developer-friendly no-code/low-code automation

### Threat Hunting
- **Elastic EQL** — event query language for hunting
- **Jupyter Notebooks + Pandas** — data science approach to hunting
- **Velociraptor** — endpoint forensics and live response at scale
- **OpenSearch** — open-source log analytics for hunt infrastructure

### Detection Engineering
- **Sigma** — vendor-neutral detection rule format
- **Sigma CLI + pySigma** — compile Sigma to platform-specific syntax
- **Atomic Red Team** — ATT&CK-mapped test library to validate detections
- **MITRE CALDERA** — adversary emulation to test detection coverage
- **Detection Lab** — pre-built lab environment for detection development

### Threat Intelligence
- **MISP** — open-source threat intelligence platform / IOC sharing
- **OpenCTI** — structured threat intelligence with ATT&CK integration
- **VirusTotal / Shodan / URLscan** — ad-hoc enrichment
- **ISAC feeds** — sector-specific threat intelligence sharing

---

## AI/LLM Assistance in Blue Team Operations (2025 Research)

LLMs are being applied in blue team operations (CyCon 2025 research):

| Use Case | Maturity | Caution |
|---|---|---|
| Log analysis — summarising large log sets | High | Verify AI conclusions before acting |
| Alert triage — classifying alert severity | Medium | Requires well-structured alert data |
| Detection rule drafting (Sigma/KQL/SPL) | Medium | Always human-review before deployment |
| IR report generation | High | Solid starting point; verify facts |
| Threat intel summarisation | High | Good for speed; check source fidelity |
| Automated ticket parsing → SOAR trigger | Medium | Works well for structured ticket formats |
| Vulnerability remediation guidance | Medium | Useful for L1/L2 analyst uplift |

**Do not** use LLMs for:
- Autonomous incident containment decisions
- Definitive malware attribution
- Legal/disclosure decisions

---

## Output Formats

**Detection rule** → Sigma YAML with ATT&CK tags and test cases
**Hunt report** → Hypothesis + methodology + findings + detection outcome
**IR timeline** → Timestamped markdown table (UTC timestamps)
**IR report** → Executive summary + technical chronology + root cause + recommendations
**ATT&CK coverage map** → Navigator JSON layer with coverage status per technique
**SOC metrics dashboard spec** → Markdown table with metric, measurement method, target, owner
