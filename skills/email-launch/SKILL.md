---
name: email-launch
description: Produce a governed launch/announcement email draft from a raw brief with the same intake → lint → HITL gate as the nurture play, defaulting to a create-only Customer.io Design Studio payload; a newsletter-pattern flag exists but carries higher blast radius. Never sends.
---

# Email launch skill

Same governed pipeline as `email-nurture` (see that SKILL.md for the full
procedure); this play differs only in ticket type and in the Customer.io
pattern decision.

## The pattern decision

`play.yaml` here carries `cio_pattern`. Default is `design_studio`,
`createDesignStudioEmail` attaches no audience and cannot send.

`newsletter` (`createNewsletter`) is available as a flag for launch-type
sends because that is where newsletters actually live, but recipients are
required at create time, which is a higher blast radius. This pipeline still
never attaches an audience (the agent has no audience-mutation permission);
the recipients field is emitted as null and a human attaches the segment in
the Customer.io UI. This is the least-locked decision in the system: if the
team prefers, the flag stays off and launches ride Design Studio too.

Campaign-action PUT is out of the POC: it would require a named journey tile
to already exist.

## Hard limits

Identical to email-nurture: no arbitrary HTTP, no send/schedule/trigger, no
audience mutation, no policy override, footer never from the model.
