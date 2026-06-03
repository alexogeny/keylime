---
name: red-team
description: >
  Adversary simulation and red teaming skill. Use when planning, scoping, or executing a red team engagement; designing adversary emulation scenarios; selecting attack vectors and tooling; mapping exercises to MITRE ATT&CK or MITRE ATLAS; or producing red team reports with prioritised remediation. Grounded in contemporary 2025–2026 research and frameworks.
---

# Red Team Skill

Use this skill when the task involves **offensive security operations**: simulating adversarial attacks, planning red team engagements, designing exploit chains, mapping TTPs, or bridging toward purple team collaboration.

---

## Background & Research Grounding (2025–2026)

Red teaming has evolved well beyond point-in-time penetration testing. The contemporary model is:

- **Adversary emulation** over generic pen testing — simulate the actual TTPs of named threat actors, APT groups, ransomware operators
- **MITRE ATT&CK** as the universal TTP taxonomy; **MITRE ATLAS** for AI/ML system targeting
- **BAS (Breach and Attack Simulation)** as the continuous automated layer; manual red teaming for deep, objective-specific engagements
- **CART (Continuous Automated Red Teaming)** emerging as the persistent model — attack simulation never stops
- **AI red teaming** bifurcated into: (a) using AI to assist red team operations; (b) red teaming AI/LLM systems themselves
- **Identity is the dominant attack surface in 2025**: Cloud Accounts (T1078.004), cloud storage exfiltration, and cloud firewall manipulation are the top MITRE ATT&CK techniques
- **Purple teaming** is now the target operating model — red and blue collaborate in tight loops rather than operating in silos

---

## Workflow

### Step 1 — Scope & Objectives

Define the engagement before touching a tool:

```
Objective:        [Crown jewel access? Detection validation? Specific threat actor emulation?]
Scope:            [In-scope systems, networks, accounts, third parties]
Out of scope:     [Explicit exclusions]
Rules of Engagement (RoE): [What is prohibited? Who holds the "break glass" contact?]
Success criteria: [How do we know the engagement succeeded?]
Threat profile:   [Generic opportunist? Named APT? Insider threat? AI system attack?]
```

Ask the operator these questions before proceeding. No engagement starts without a documented RoE.

### Step 2 — Threat Profile & TTP Selection

Map the engagement to a framework:

**For infrastructure/network/identity engagements → MITRE ATT&CK**
Work through the 14 tactic categories:
1. Reconnaissance
2. Resource Development
3. Initial Access
4. Execution
5. Persistence
6. Privilege Escalation
7. Defense Evasion
8. Credential Access
9. Discovery
10. Lateral Movement
11. Collection
12. Command & Control (C2)
13. Exfiltration
14. Impact

For each selected technique, note:
- Technique ID (e.g., T1078.004 — Cloud Accounts)
- Detection difficulty (high / medium / low for defender)
- Tooling (native OS, open-source, commercial)
- Chaining opportunities (which technique enables the next)

**For AI/ML system engagements → MITRE ATLAS**
16 tactics, 84 techniques covering:
- Prompt injection, jailbreaking, model inversion
- Training data poisoning, adversarial examples
- Model extraction, evasion

**For LLM/GenAI systems → OWASP Gen AI Red Teaming Guide**
- Prompt injection (direct and indirect)
- Jailbreaks and guardrail bypass
- Data exfiltration via model outputs
- System-prompt extraction
- NIST AI RMF alignment for continuous testing

### Step 3 — Reconnaissance

Passive (OSINT) before active:

```
OSINT targets:
- Employee LinkedIn profiles (org chart, technology stack clues)
- Job postings (reveals internal tooling)
- GitHub/GitLab leaks (API keys, credentials, infra config)
- Shodan/Censys (exposed services, certificates, banners)
- WHOIS, DNS enumeration, certificate transparency logs
- EASM (External Attack Surface Management) tools
```

Document findings as structured data — feed into Step 2 to refine TTP selection.

### Step 4 — Initial Access

Select vectors aligned to threat profile. In priority order for 2025 threat landscape:

| Vector | Notes |
|---|---|
| **Phishing / Spearphishing** | Still #1 initial access path; AI-generated lures now baseline |
| **Valid Credentials** | Credential stuffing, password spray, MFA fatigue attacks |
| **Cloud Identity Abuse** | T1078.004 — dominant 2025 technique |
| **Supply Chain Compromise** | Third-party software/vendor access |
| **Exposed Services** | VPN, RDP, Exchange, misconfigured cloud storage |
| **Social Engineering** | Vishing, pretexting, physical (if in scope) |
| **Zero-Day-Like** | Novel exploit chains — manual red team strength vs BAS |

### Step 5 — Post-Exploitation Chain

Design a multi-stage attack path. Minimum viable chain:

```
Initial Access → Execution → Persistence → Privilege Escalation
→ Defense Evasion → Lateral Movement → Credential Access
→ Collection → C2 Establishment → Exfiltration / Impact
```

At each stage:
- Select technique(s) from ATT&CK
- Select tooling (prefer OPSEC-safe options for stealth engagements)
- Define the "objective gate" — what proof of success is needed before proceeding

**2025 C2 Framework landscape** (select based on engagement stealth requirements):
- **Cobalt Strike** — industry standard; heavily signatured, requires malleable profiles
- **Sliver** — open-source, actively developed, good OPSEC defaults
- **Havoc** — modern open-source; good for evasion research
- **Brute Ratel C4** — commercial, designed to evade EDR
- **Custom / living-off-the-land** — native OS tools (PowerShell, WMI, certutil) to minimise footprint

### Step 6 — Defense Evasion Planning

Think like the defender's tooling:
- Which EDR is deployed? (CrowdStrike / SentinelOne / Defender for Endpoint)
- Is AMSI (Antimalware Scan Interface) likely to fire?
- What LOLBins (Living Off the Land Binaries) are available?
- Is there NDR / network detection that will catch C2 beaconing?
- Are cloud API calls logged? (CloudTrail, Unified Audit Log)

Design payloads and techniques to stay below detection thresholds for the declared threat profile.

### Step 7 — Evidence Collection & Documentation

At every stage capture:
```
- Timestamp (UTC)
- Technique ID (ATT&CK / ATLAS reference)
- Action taken (exact command / payload)
- System / account targeted
- Result (success / failure / detection triggered)
- Screenshot or log evidence
- Detection gap identified (yes / no)
```

This is the raw material for the final report.

### Step 8 — Deconfliction & Safety

Before executing destructive or high-impact techniques:
- Confirm with the break-glass contact
- Never deploy ransomware simulators without written authorisation
- Avoid DoS/DDoS actions unless explicitly in scope
- Sanitise any credentials captured — do not store outside the engagement environment
- Document "what if" blast radius for each high-risk action

### Step 9 — Reporting

Structure the deliverable in two layers:

**Executive Summary (non-technical)**
- Engagement objective and dates
- Top 3–5 findings with business impact
- Overall risk rating
- One-paragraph narrative of the attack chain achieved

**Technical Report**
- Scope and RoE
- Attack path narrative (chronological)
- Finding-by-finding breakdown:
  - ATT&CK Technique ID
  - Description and evidence
  - Business impact
  - Remediation recommendation (specific, prioritised)
- Detection gap analysis (what the blue team missed, and why)
- Remediation prioritisation matrix (risk × effort)

### Step 10 — Purple Team Handoff

After the engagement, run a structured purple team session:
1. Red shares every TTP with timestamped evidence
2. Blue team checks detection logs against each action
3. For each missed detection: write a new detection rule
4. For each alert that fired: assess response time and quality
5. Re-run the technique after the blue team update to verify the fix
6. Document as a closed loop in the engagement record

---

## AI Red Teaming Sub-Workflow

When the target is an **AI/LLM system**, follow this additional workflow:

### Scope for AI Systems
```
Model type:       [LLM / image model / recommendation system / agentic system]
Deployment:       [API / embedded / autonomous agent]
Trust boundary:   [What can users inject? What data is in context?]
Harm categories:  [Harmful content / data exfiltration / privilege escalation / misinformation]
```

### AI Attack Vectors (OWASP Gen AI + MITRE ATLAS)
| Vector | Description |
|---|---|
| **Direct Prompt Injection** | User-provided input overrides system instructions |
| **Indirect Prompt Injection** | Malicious content in retrieved documents/tools hijacks model |
| **Jailbreaking** | Adversarial prompts bypass safety guardrails |
| **System Prompt Extraction** | Eliciting confidential system instructions from the model |
| **Training Data Poisoning** | Injecting malicious examples to influence model behaviour (pre-deployment) |
| **Model Inversion / Extraction** | Reconstructing training data or model weights via repeated queries |
| **Adversarial Examples** | Crafted inputs that cause misclassification or evasion |
| **Agentic Exploitation** | Manipulating tool-use, memory, or multi-agent trust chains |

### AI Findings Format
For each finding, record:
- Vector category (OWASP / ATLAS reference)
- Exact prompt or input that triggered the behaviour
- Model response (verbatim)
- Harm assessment: what could an adversary achieve?
- Severity (Critical / High / Medium / Low)
- Recommended mitigation (input validation, output filtering, system prompt hardening, RLHF re-training, etc.)

---

## Tooling Reference (2025–2026)

### Reconnaissance
- `amass`, `subfinder`, `theHarvester` — passive OSINT / subdomain enumeration
- `shodan` / `censys` — internet-exposed asset discovery
- `trufflehog`, `gitleaks` — credential leak scanning in repos

### Initial Access & Phishing
- `GoPhish` — phishing campaign infrastructure
- `Evilginx2` — reverse-proxy MFA phishing
- `SET (Social Engineer Toolkit)` — social engineering framework

### C2 & Post-Exploitation
- `Sliver`, `Havoc`, `Cobalt Strike` — C2 frameworks
- `Impacket` — network protocol exploitation (Windows/AD)
- `BloodHound` / `SharpHound` — Active Directory attack path mapping
- `Mimikatz` / `Rubeus` — credential extraction (Windows)
- `CrackMapExec` / `NetExec` — lateral movement automation

### Cloud & Identity
- `ScoutSuite` — multi-cloud security auditing
- `Pacu` — AWS exploitation framework
- `AADInternals` — Azure AD / Entra ID testing
- `PowerZure` — Azure post-exploitation

### Vulnerability Assessment
- `Nuclei` — fast template-based vulnerability scanner
- `Metasploit` — exploitation framework
- `Burp Suite Pro` — web application testing

### BAS / Continuous Simulation
- `Picus Security`, `AttackIQ`, `SafeBreach` — commercial BAS platforms
- `Atomic Red Team` (Red Canary) — open-source ATT&CK-mapped test library
- `CALDERA` (MITRE) — open-source adversary emulation platform

---

## Output Formats

When producing engagement artefacts, use these formats:

**Scope document** → Markdown table (system, IP/URL, in/out of scope, owner)
**TTP map** → ATT&CK Navigator layer JSON or Markdown matrix
**Finding** → Structured record (see Step 7)
**Executive summary** → Max 1 page, plain English, business risk framing
**Technical report** → Sectioned Markdown / PDF with evidence appendix

---

## Ethics & Legal

> ⚠️ All red team activities must occur within written authorisation. Unauthorised access is a criminal offence in all jurisdictions.

- Never proceed without a signed Statement of Work and RoE document
- Sanitise all captured credentials immediately after the engagement
- Notify the break-glass contact before any action that could cause outage
- Data collected during engagements must be handled per the client's data handling policy
- Apply minimum necessary access — do not escalate privileges beyond what the objective requires
- All findings must be disclosed to the client; no independent disclosure without consent
