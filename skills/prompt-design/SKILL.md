# Prompt Design

## Four Principles (Anthropic-aligned)

1. **Be clear, direct, and specific.** Say the thing plainly. Spell out the desired output, format, and constraints.
2. **Tell the model what TO do, not what NOT to do.** Replace "Do not / Never / Don't" with the positive action you want.
3. **Add context — explain the why.** A reason makes the rule generalize beyond the cases you listed.
4. **Prefer general principles over prescriptive case lists.** A short principle the model can reason from beats a long list of specific "if X then Y" patches.

Source: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices

## Self-Review Before Shipping

After drafting or editing a prompt, scan it once and ask:

- Are any rules in conflict with each other?
- Is "Don't / Never / NEVER" piling up? Can each be flipped to a positive action?
- Am I patching a specific failure case, or expressing a design principle?
- Is there content this role doesn't need (details that belong to a different role's prompt)?
- Does each added "reason" sharpen the rule, or dilute it?

## Common Failure Mode

Reading a model's failure observation and writing rules in the shape of that observation — turns the prompt into a defensive checklist of past mistakes. Result: long, negative, brittle. Fix: extract the underlying principle, write that instead.
