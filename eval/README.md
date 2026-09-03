# eval

프롬프트 정책을 고정된 평가 집합으로 채점하는 루프의 작업 디렉터리입니다.

```
eval/gold/*.json   사람이 검토한 결과에서 만든 평가 집합 (pnpm eval:export)
eval/results.tsv   실행별 점수 기록 (pnpm eval)
```

## 루프

```bash
pnpm eval:export              # 승인·거부한 추론 결과를 gold set으로 고정
pnpm eval --repeat 3          # 먼저 baseline 분산을 측정한다
# server/inferencePrompt.ts 를 수정한다  ← 수정 가능한 유일한 파일
pnpm eval --label "무엇을 바꿨는지"
# 점수가 2×표준편차 이상 올랐으면 유지, 아니면 revert
```

## 점수

```
score = 1 − (2·환각률 + section 혼동률 + 0.5·과보수율)
```

셀마다 결과가 하나씩 붙습니다.

| 결과             | 뜻                                            |
| ---------------- | --------------------------------------------- |
| `MATCHED`        | 근거가 있는 셀에 옳은 인용으로 답함           |
| `CORRECT_ABSENT` | 근거 section은 있지만 답할 내용이 없어 침묵함 |
| `TRIVIAL_ABSENT` | 근거 section 자체가 없음 — **점수에서 제외**  |
| `FABRICATED`     | 근거가 없는데 답함 (가중치 2배)               |
| `CONFUSED`       | 저자 한계와 리뷰어 지적을 뒤바꿈              |
| `MISQUOTED`      | 옳은 셀이지만 다른 문장을 인용함              |
| `MISSED`         | 답할 근거가 있는데 침묵함                     |
| `UNCOVERED`      | 정책이 scope에서 제외해 판정 자체를 하지 않음 |

`TRIVIAL_ABSENT`가 점수에서 빠지는 이유: 근거를 주지 않은 section에는
`validateInferenceClaims`가 어차피 답변을 통과시키지 않습니다. 실패할 수 없는 셀을
성공으로 세면 빈 section이 많은 gold set은 어떤 프롬프트에도 높은 점수를 줍니다.

`UNCOVERED`가 miss로 계산되는 이유: scope를 좁히면 판정할 셀이 줄어 점수가 오르는
지름길이 생깁니다. 좁히는 선택에는 항상 비용이 붙어야 합니다.

## 주의

- 게이트웨이에 temperature 설정이 없어 **같은 프롬프트도 실행마다 점수가 다릅니다.**
  `--repeat`로 분산을 먼저 재고, 그보다 작은 변화는 개선으로 읽지 마십시오.
- 라벨 20개 미만에서는 셀 하나가 점수를 크게 흔듭니다.
- 같은 gold set에 수십 번 맞추면 그 gold set에만 맞춰집니다. 일부를 떼어
  `pnpm eval --gold eval/holdout`으로 따로 확인하십시오.
