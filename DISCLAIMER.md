# Disclaimer & Limitation of Liability

**Project:** `n8n-hubspot-duplicate-company-domain-fuzzy-matcher`
**Publisher:** DH Robin (dhRobin Systems)
**Applies to:** every file in this repository, including the n8n workflow JSON, the Node.js source in `src/`, the build script, the tests, the fixtures and the documentation.

## 1. Purpose

This repository is published as an educational and architectural reference for RevOps teams. It shows one way to audit HubSpot company records for likely duplicates and to route a review queue to Slack or Notion. It is not a managed product, a hosted service or professional advice, and it does not replace your own engineering, security, legal or data-protection review.

## 2. "As is", without warranty

The software is provided **"AS IS" and "AS AVAILABLE", without warranty of any kind**, express or implied. This includes, without limitation, warranties of merchantability, fitness for a particular purpose, title, non-infringement, accuracy, completeness and uninterrupted or error-free operation. No advice or information, written or spoken, from the author or dhRobin Systems creates any warranty.

## 3. Fuzzy matching is probabilistic

Similarity scores are heuristics. The matcher **will** produce false positives (distinct companies that look alike) and false negatives (real duplicates it misses). A cluster in the review queue is a prompt for a human to look, not a finding that two records are the same organisation. You alone decide whether any records are merged, edited or deleted.

## 4. Scope of what the software does

As published, the software only **reads** HubSpot data (account details and company properties) and **writes** review-queue messages to Slack and pages to Notion when `DRY_RUN=false`. It does not merge, update or delete HubSpot records. If you modify it to do so, you take full responsibility for those changes and their effects.

## 5. Safe-by-default settings are not a guarantee

`DRY_RUN=true`, `SANDBOX_MODE=true`, the sandbox account check and the secret masking reduce risk; they do not remove it. Configuration mistakes, changes to third-party APIs, n8n version differences or modifications to the code can bypass or weaken them. Test in an isolated environment before every production rollout and after every upgrade.

## 6. Limitation of liability

To the maximum extent permitted by applicable law, in no event shall the author, DH Robin, dhRobin Systems or any contributor be liable for any direct, indirect, incidental, special, exemplary, punitive or consequential damages, or for any loss of data, revenue, profit, business, goodwill or records, or for the cost of substitute services, however caused and on any theory of liability, whether in contract, strict liability or tort (including negligence), arising in any way out of the use, misuse, inability to use or deployment of this software, even if advised of the possibility of such damage.

## 7. Your responsibilities

You are solely responsible for:

- keeping credentials secret and scoped to the minimum (`crm.objects.companies.read` for HubSpot);
- complying with the terms of service, acceptable-use policies and rate limits of HubSpot, Slack, Notion, n8n and any other connected service;
- complying with data-protection law (including GDPR and CCPA/CPRA), including deciding where review-queue data may be stored and who may see it, since company names, domains, deal counts and revenue figures are copied into Slack and Notion;
- confirming a lawful basis before combining records, and honouring the consent and subscription preferences attached to every record and its associated contacts;
- reviewing every merge and property overwrite you make based on this tool's output.

## 8. No affiliation

HubSpot, Slack, Notion and n8n are trademarks of their respective owners. This project is independent and is not affiliated with, endorsed by or sponsored by any of them. All company names, domains and identifiers in this repository are fictional.

## 9. License

The software is licensed under the MIT License (see [LICENSE](LICENSE)). If anything in this disclaimer conflicts with the MIT License, the MIT License governs; this document adds explanation and does not grant or remove rights.

---

## ⚠️ Disclaimer & Liability Limitation

**Use at your own risk.** The code, workflows, and scripts provided in this repository (`n8n-hubspot-duplicate-company-domain-fuzzy-matcher`) are for educational and architectural demonstration purposes.

* **No Liability:** The author and dhRobin Systems assume no responsibility or liability for any direct, indirect, incidental, or consequential damages resulting from the use, misuse, or deployment of these scripts.
* **No Warranty:** All software, n8n JSON blueprints, and JavaScript modules are provided "AS IS" without warranty of any kind, express or implied, including but not limited to merchantability, fitness for a particular purpose, or non-infringement.
* **Production Testing Required:** Always test thoroughly in an isolated staging environment (for example a HubSpot developer test account or sandbox) with `SANDBOX_MODE=true` and `DRY_RUN=true` enabled before connecting live HubSpot credentials. This tool never merges records itself, but treat every merge you make from its review queue as irreversible.
* **Third-Party APIs & Compliance:** Users are solely responsible for complying with the terms of service, rate limits, data privacy regulations (GDPR/CCPA), and security policies of HubSpot and any connected services. That includes confirming a lawful basis for combining records, honouring the consent and subscription preferences of every merged record, and reviewing every merge and property overwrite made from the review queue.

The full disclaimer is also available in [DISCLAIMER.md](https://github.com/dhrobinsystems/n8n-hubspot-duplicate-company-domain-fuzzy-matcher/blob/main/DISCLAIMER.md).

## License

Released under the MIT License. Copyright (c) 2026 DH Robin (dhRobin Systems). See [LICENSE](https://github.com/dhrobinsystems/n8n-hubspot-duplicate-company-domain-fuzzy-matcher/blob/main/LICENSE).
