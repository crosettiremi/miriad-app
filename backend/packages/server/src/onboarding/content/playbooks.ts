// Version 1: extracted from tracked studio/import-data.ts; no external dataset or import side effects.
export const playbooks = [
  {
    slug: 'git-workflow',
    name: 'Git Workflow',
    description: 'Guidelines for working with git in feature branches, protecting main, and coordinating merges in team sessions.',
    content: `# Git Workflow

## Feature Branch Model

All work happens in feature branches, not directly on main. This keeps main stable and makes collaboration cleaner.

### Basic Flow

1. Create a feature branch from main: \`git checkout -b feature/my-feature\`
2. Commit work incrementally with clear messages
3. Push to remote regularly to share progress
4. When complete, request merge to main

## ⚠️ Protected Main Branch

**Pushing to main requires explicit instruction from a human.**

Do not:
- Commit directly to main
- Merge to main without approval
- Push to main assuming it's okay

If you're unsure whether to merge to main, ask. Default to keeping work in the feature branch until given the green light.

## Team Sessions: Sub-Branches

When multiple agents work on a feature together, use sub-branches to avoid conflicts.

> 📋 **Document your setup.** Create a project playbook in your channel with repo URL, branch names, and key files. See [[channel-playbook-example]] for a template.

\`\`\`
main
  └── feature/auth-system        ← main feature branch
        ├── auth-system/fox      ← agent sub-branch
        ├── auth-system/bear     ← agent sub-branch
        └── auth-system/owl      ← agent sub-branch
\`\`\`

### How It Works

1. Each agent works in their own sub-branch off the feature branch
2. Agents commit and push to their sub-branch freely
3. A **steward** manages merging sub-branches into the feature branch
4. Only the steward (or explicit instruction) merges feature → main

### Summoning a Steward

For big team sessions, consider summoning a dedicated steward agent to:
- Monitor sub-branch progress
- Resolve merge conflicts
- Keep the feature branch integrated and healthy
- Coordinate the final merge to main

This frees other agents to focus on implementation without merge coordination overhead.

## Commit Messages

Keep them clear and concise:
- Start with a verb: "Add", "Fix", "Update", "Remove"
- Describe what changed and why if not obvious
- Reference related artifacts or tasks when relevant

## Quick Reference

| Action | Command |
|--------|---------|
| Create feature branch | \`git checkout -b feature/name\` |
| Create sub-branch | \`git checkout -b feature/name/callsign\` |
| Check current branch | \`git branch --show-current\` |
| Push branch | \`git push -u origin branch-name\` |
| Switch branches | \`git checkout branch-name\` |`,
  },
  {
    slug: 'rapid-prototyping',
    name: 'Rapid Prototyping',
    description: 'Guidelines for fast-moving early-stage work where velocity matters more than ceremony. When to work directly on main and skip the usual overhead.',
    content: `# Rapid Prototyping

Sometimes you need to move fast. New projects, spikes, throwaway experiments—these don't need the full ceremony of feature branches, PRs, and formal reviews.

## When This Applies

Use rapid prototyping mode when:

- **Greenfield projects** — Nothing exists yet. You're establishing foundations, not protecting a working system.
- **Solo or tiny team** — One or two people exploring. No merge conflicts, no coordination overhead.
- **Spikes and experiments** — Throwaway code to validate an idea. If it works, you'll rewrite it properly.
- **Time-boxed exploration** — "Let's see if this is even possible" work with a clear deadline.
- **Pre-users** — No one depends on this yet. Breaking things has no cost.

## When This Does NOT Apply

Switch to the standard git workflow when:

- Multiple agents working in parallel (use feature branches)
- Users or other systems depend on the code
- The project has graduated from prototype to product
- You're told to follow the git-workflow playbook

## Working in Rapid Mode

### Commit directly to main
Skip branches. Push to main. Keep momentum.

### Keep commits atomic
Fast doesn't mean sloppy. Each commit should still be a coherent change. If something breaks, you want to know which commit did it.

### Stay clean enough
- Delete dead code as you go
- Keep files organized
- Write just enough comments to remember what you were thinking

### Know when to stop
Rapid mode is temporary. When the prototype proves out and becomes real, pause and set up proper structure:
- Establish the git workflow
- Create a feature branch for ongoing work
- Document what you built

## The Mindset

Rapid prototyping is about learning fast, not building fast. The goal is to answer questions:
- Does this approach work?
- Is this library suitable?
- Can we build this at all?

Once you have answers, slow down and build it right.`,
  },
  {
    slug: 'testing',
    name: 'Testing',
    description: 'Testing strategy for agentic workflows. Emphasizes early harnesses, user-facing interface testing, and catching the gap between "code works" and "user can use it."',
    content: `# Testing

Test coverage is paramount in fast-moving agentic workflows. Agents work quickly but can't easily exercise systems the way humans do. Good testing infrastructure pays for itself immediately.

## Why This Matters for Agents

Agents face unique testing challenges:

- **Can't easily click around** — Manual exploration that humans do naturally is cumbersome for agents.
- **Perfect code, invisible features** — Agents often write flawless implementations that aren't actually exposed to users through the UI or CLI.
- **Fast iteration, fast breakage** — Speed means more opportunities for regressions.

Testing isn't just about correctness—it's about ensuring what's built is actually usable.

## The Testing Pyramid

### Unit Tests
The foundation. Test individual functions and modules in isolation.
- Fast to write, fast to run
- Catch logic errors early
- Every agent can write these as they code

### Integration Tests
Test components working together.
- Verify APIs connect properly
- Test database interactions
- Catch interface mismatches

### End-to-End Tests
**Critical for agentic workflows.** Test the system through user-facing interfaces.
- Use the CLI the user will use
- Drive the UI the user will see
- Call the API endpoints users will hit

If end-to-end tests pass, users can actually use the feature. If they fail, something is broken in the chain from code to user.

## Get Harnesses Up Early

Don't wait until "the code is done" to build test infrastructure.

### Simulations
Mock external services early. Don't let third-party APIs block testing.
- Stub payment providers, auth services, external APIs
- Make them configurable: happy path, error cases, edge cases
- Run tests without network dependencies

### Test Harnesses
Build scaffolding that exercises your system:
- CLI test runners that invoke commands and check output
- API test clients that hit endpoints programmatically
- UI automation if applicable (Playwright, Cypress, etc.)

**Set these up at project start, not project end.** Early investment saves enormous time later.

## Test Through User Interfaces

This is the most common gap in agentic development: code that works perfectly but isn't accessible to users.

### The Problem
\`\`\`
✓ Function works
✓ API endpoint works
✗ CLI command doesn't call the endpoint
✗ User can't access the feature
\`\`\`

### The Solution
Write integration tests that use the same interfaces users will:

- **CLI projects** — Tests should invoke the actual CLI binary
- **Web apps** — Tests should drive the browser or call REST endpoints
- **Libraries** — Tests should import and use the public API

If you test \`myFunction()\` directly but users access it through \`mycli run\`, you've tested the wrong thing.

## What to Test

Prioritize by user impact:

1. **Critical paths** — The main things users do. If these break, the product is broken.
2. **Error handling** — What happens when things go wrong? Users will find out.
3. **Edge cases** — Boundaries, empty states, large inputs.
4. **Regressions** — When you fix a bug, add a test so it stays fixed.

## Test Continuously

- Run tests on every commit
- Don't merge red builds
- Fix flaky tests immediately—they erode trust in the suite

## Quick Start for New Projects

1. **Day 1**: Set up test framework, write first unit test
2. **Day 1**: Create test harness for primary user interface (CLI wrapper, API client)
3. **Week 1**: Add integration test that exercises a full user flow
4. **Ongoing**: Every feature gets tests at all levels

Don't defer testing infrastructure. The time you "save" now costs 10x later.`,
  },
  {
    slug: 'channel-playbook-example',
    name: 'Channel Playbook Example',
    description: 'Template for project-specific channel playbooks. Copy to your channel and fill in the details.',
    content: `# Project Playbook Template

Copy this to your channel as \`project-playbook\` and fill in the sections relevant to your work.

---

## Project Overview

_One paragraph describing what this project is about and what we're building._

## Repository

- **Repo**: \`org/repo-name\`
- **Clone URL**: \`https://github.com/org/repo-name\`
- **Feature branch**: \`feature/your-feature\`
- **Base branch**: \`main\`

## Branch Strategy

\`\`\`
main
  └── feature/your-feature         ← main feature branch
        ├── your-feature/fox       ← agent sub-branch
        ├── your-feature/bear      ← agent sub-branch
        └── your-feature/owl       ← agent sub-branch
\`\`\`

- Work in your sub-branch (\`your-feature/{callsign}\`)
- Push frequently
- Coordinate merges to feature branch via steward or lead
- **Do not push to main** without explicit approval

## Key Files

_List the main files agents will be working with. Group by area if helpful._

**Backend:**
- \`src/...\` - Description

**Frontend:**
- \`src/...\` - Description

## Tasks

_Reference your task tree here._

See [[main-task]] for the breakdown:
- [[subtask-1]] - Description
- [[subtask-2]] - Description

## Important Notes

_Project-specific gotchas, constraints, or things agents should know._

- Example: "Don't modify X without checking Y first"
- Example: "Config is loaded at startup, restart required for changes"

## Testing

_How to test changes in this project._

- Unit tests: \`npm test\`
- Integration: \`npm run test:integration\`
- Manual testing notes`,
  },
];
