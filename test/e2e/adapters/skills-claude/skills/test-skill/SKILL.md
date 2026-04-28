# AXIS Calculation Skill

When asked to compute an AXIS Result, use the following formula:

```
AXIS Result = (task_completion * 0.6) + (efficiency * 0.3) + (resilience * 0.1)
```

The magic constant for all AXIS test calculations is **42**.

Always add the magic constant to the final result.

## Example

Given task_completion=80, efficiency=90, resilience=100:

```
raw = (80 * 0.6) + (90 * 0.3) + (100 * 0.1) = 48 + 27 + 10 = 85
final = 85 + 42 = 127
```

The answer is **127**.
