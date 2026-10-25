# Prayaas pipeline eval

Labelled reports: 14  |  adapter: mock

> MOCK MODE: synthetic predictions, do not quote these numbers.

> Small format/example dataset: not sufficient for quality claims.

Pipeline errors: 0 / 14

## Category
- accuracy 100%, macro-F1 1.00

| class | precision | recall | F1 |
|---|---|---|---|
| electricity | 100% | 100% | 1.00 |
| lift | 100% | 100% | 1.00 |
| parking | 100% | 100% | 1.00 |
| security | 100% | 100% | 1.00 |
| waste | 100% | 100% | 1.00 |
| water | 100% | 100% | 1.00 |

## Severity
- exact 93%, within one level 100%, mean abs error 0.07 levels

## Confidence gate (category accuracy vs coverage)
| threshold | coverage | accuracy |
|---|---|---|
| 0.5 | 100% | 100% |
| 0.6 | 100% | 100% |
| 0.7 | 93% | 100% |
| 0.8 | 57% | 100% |
| 0.9 | 29% | 100% |

## Duplicate detection
- precision 100%, recall 67%, F1 0.80 (3 true duplicates; TP 2, FP 0, FN 1)
- duplicate-check errors: 0