# AX-Research 코드 검토 — Claude 전달용

검토일: 2026-09-08

이 문서는 Codex가 저장소 코드를 읽고 수행한 검토 결과입니다. 아래 지적을 실제 코드와 대조해 확인해 주세요. 파일 경로와 줄 번호는 검토 당시 기준입니다. 확정된 코드 동작과 추정 위험을 구분했습니다.

현재 구현은 **“인용이 존재한다”는 검사와 “답변이 인용으로 뒷받침된다”는 검사를 혼동**하고 있습니다. 핵심 계약을 보장하지 못하며, 평가도 이 결함을 성공으로 채점합니다. 인증을 우회하는 파일 접근 경로도 있어 판매 전 수정이 필요합니다.

검토 중 코드는 변경하지 않았습니다. `pnpm test`는 **130개 통과·14개 건너뜀**, `pnpm check`는 통과했습니다. 아래 재현은 로컬 함수 호출로 확인했으며, 실제 Google·R2·운영 DB를 대상으로 공격하거나 삭제하지 않았습니다.

## 1. [P1] 원문과 반대되는 답변도 심판을 통과합니다

위치: `server/inferenceService.ts:222`, `validateInferenceClaims`; `server/paperDigest.ts:224`, `validateDigestEntries`, `validateAnalystExtraction`.

추론 심판이 검사하는 것은 노트 ID, section 종류, 인용 ID의 소속뿐입니다. `answer`의 내용과 `supportStatus`는 검사하지 않습니다.

직접 재현한 입력과 결과입니다.

```text
원문: Accuracy decreased by ten percent.
답변: 정확도가 99% 상승했다
인용: 해당 원문의 정상 evidence ID
supportStatus: not_found

결과: claim 통과, missing=[], 평가 score=1
```

요약도 실제 원문의 12자 이상 구절 하나를 붙이면 그와 무관한 `draft`, 데이터셋, 성능 수치를 `SUPPORTED`로 만들 수 있습니다.

서버가 확실히 보장할 수 있는 추출형 답변과 자유 서술을 구분해야 합니다. 자유 서술을 유지한다면 주장별 의미적 근거 검사가 추가로 필요하고, 그 검사 역시 완전한 보장은 아니라는 전제로 설계해야 합니다.

## 2. [P1] computeMissingSections는 모델의 영향을 간접적으로 받습니다

위치: `server/inferenceService.ts:370`, `runEvidenceInference` → `computeMissingSections`.

모델의 `missing` 배열은 무시하지만, 모델이 만든 claim에서 `claimedKeys`를 생성합니다. 따라서 `not_found`, `ambiguous`, 빈 답변이라도 유효한 인용 ID만 붙이면 해당 셀의 `no_quote_found`가 사라집니다. 조건에 따라 실행 전체가 `SUCCEEDED`가 됩니다.

검증된 답변에 따라 missing이 달라지는 것은 자연스럽습니다. 문제는 현재 “검증된 답변”의 기준이 ID 연결뿐이라는 점입니다. `section_missing`·`source_unavailable`과 질문에 답할 근거의 충분성을 분리하고, 답변으로 인정할 상태와 내용 조건을 서버에서 강제해야 합니다.

## 3. [P1] 요약 화면은 검증하지 않은 내용과 검증에 실패한 내용을 표시합니다

위치: `server/paperDigest.ts:317`, `validateAnalystExtraction`; `server/paperDigest.ts:525`, `runPaperDigest`; `client/src/components/PaperDigestPanel.tsx:110`, `PaperDigestPanel`.

- `summary`는 검사 없이 화면 상단에 표시됩니다.
- analyst claim은 인용이 없어 `ABSENT`여도 본문이 표시됩니다. 경고 배지는 `REJECTED`에만 붙습니다.
- 가설·검증 결과·데이터셋·한계·재현 정보는 각 항목의 검증 상태와 무관하게 표시됩니다.
- 가설·검증·한계 등의 인용은 화면에서 함께 보여주지도 않습니다.

`{text:"없는 성능 수치 99%", quote:""}`가 `ABSENT` 상태로 본문을 유지하는 것까지 재현했습니다. “초안” 경고는 “근거 없는 답변을 버린다”는 계약을 충족하지 못합니다. 서버 반환 DTO에서부터 미검증 본문을 제거하고, 모든 표시 필드에 동일한 규칙을 적용해야 합니다.

## 4. [P2] 인용 정규화의 Unicode 위치 계산이 틀립니다

위치: `server/paperDigest.ts:172`, `locateQuote`.

문자 하나를 소문자화했을 때 여러 코드 단위가 생겨도 `offsets`에는 위치 하나만 넣습니다. 다음을 재현했습니다.

```ts
locateQuote("abcdefghijkl", "İ abcdefghijklXYZ")
// 실제 반환: "bcdefghijklX"
```

검증한 구절과 반환하는 구절이 다릅니다. 반환값은 여전히 원문에서 자른 부분이므로 이 버그 자체가 임의 문장을 합성하지는 않습니다. 그러나 인용의 정확성을 깨뜨립니다. 정규화 결과의 각 코드 단위에 원문 위치를 매핑해야 합니다.

별도로 `server/paperFullText.ts:77`의 `stripTags`는 수식을 통째로 삭제합니다. 예를 들어 서로 다른 수학적 조건이 모두 제거된 문장을 “원문 인용”으로 검증할 수 있습니다. 수식·수치가 포함된 원문을 보존하는 추출이 필요합니다.

## 5. [P1] 평가가 답변 품질을 보지 않아 인용만 맞추면 만점입니다

위치: `server/inferenceEval.ts:241`, `claimsWithQuotes`; 같은 파일의 `scoreGoldCase`, `quotesOverlap`.

채점 입력에서 `answer`와 `supportStatus`를 버립니다. 따라서 올바른 설명, 반대 설명, 무의미한 답변이 같은 인용을 달면 같은 점수입니다.

또한 다음 조작이 가능합니다.

- section 전체를 인용하면 그 안의 gold 구절을 포함하므로 `MATCHED`.
- 같은 셀에 여러 오답과 정답 인용 하나를 넣어도 `some()` 때문에 `MATCHED`.
- 양방향 부분 문자열 검사라서 gold 문장의 짧은 일부만 인용해도 성공.
- gold에 없는 셀의 추가 답변은 평가하지 않음.

특히 `selectEvidence`는 수정이 허용된 프롬프트 파일에 있습니다. 심판은 이 함수가 만든 인용을 저장 원문과 다시 대조하지 않습니다. 즉 **수정 가능한 정책이 심판의 증거와 평가의 분모까지 바꿀 수 있습니다.**

원문 대조와 평가 대상 셀은 고정된 심판 영역으로 옮기고, 답변의 정확성·추가 주장·인용의 충분성을 별도로 채점해야 합니다.

## 6. [P1] 모든 평가가 실패해도 점수는 1.0입니다

위치: `server/runEval.ts:173`, `runOnce`의 catch; `server/inferenceEval.ts:187`, `aggregate`.

실패 케이스는 `cells: []`로 기록됩니다. 집계는 오류를 무시하고 셀만 세므로 실패한 케이스가 분모에서 사라집니다. 모든 케이스가 실패하면 손실이 0이라 `score=1`입니다. 직접 재현했습니다.

JSON 실패나 출력 잘림을 늘리는 프롬프트가 점수를 높일 수 있습니다. 실패를 고정된 평가 셀의 실패로 반영하거나, 실패가 있는 실행은 개선 후보로 채택하지 못하게 해야 합니다. 평가 가능한 셀이 0개라면 점수는 “평가 불가”여야 합니다.

## 7. [P2] 현재 가중치와 분모는 보수적인 무응답을 높은 품질처럼 보이게 합니다

위치: `server/inferenceEval.ts:187`, `aggregate`, `scoreGoldCase`.

환각 2, 누락 0.5는 **환각을 누락보다 4배 벌점** 주는 선택입니다. 제품 목표와 방향은 맞지만, 이 수치의 타당성을 입증하는 근거는 코드에 없습니다. 평가 셀의 20%만 `SUPPORTED`이면 모두 침묵하는 모델도 0.9점을 받습니다.

`TRIVIAL_ABSENT` 제외는 **증거 공급 조건이 고정되어 있을 때** 타당합니다. 현재는 수정 가능한 `selectEvidence`가 근거를 제거해 어려운 ABSENT 셀을 분모 밖으로 옮길 수 있습니다.

`CONFUSED`는 계약 회귀를 잡는 진단값으로 남길 수 있지만, 심판이 대부분 차단하므로 주요 품질 지표로서 정보량은 작습니다. 혼동 시도를 측정하려면 심판 전 출력도 별도로 집계해야 합니다.

환각률·응답률·정답 재현율을 각각 보고, “환각률 상한을 만족할 때 재현율 개선”처럼 채택 조건을 두는 편이 목표에 더 직접적입니다.

## 8. [P1] 비로그인 사용자도 원문 파일의 서명 URL을 발급받습니다

위치: `server/_core/storageProxy.ts:10`, `registerStorageProxy`.

`GET /storage/*`는 인증과 소유권 확인 없이 요청한 key를 `storageGetSignedUrl`로 전달합니다. 파일 key를 알면 다른 사용자의 원문을 내려받을 수 있습니다.

key를 무작위로 맞혀야 한다는 뜻은 아닙니다. 링크 공유·로그 노출 등으로 한 번 알려진 경로가 계속 다운로드 권한으로 작동합니다. 서명 URL이 5분 후 만료되어도 프록시에서 다시 발급받을 수 있습니다.

노트·추론·검토 API의 workspace 검사와 별개로 존재하는 우회입니다. 인증 후 key가 현재 사용자의 note version에 속하는지 검사해야 합니다.

## 9. [P1] OAuth 오류 페이지에 반사형 XSS 경로가 있습니다

위치: `server/_core/oauth.ts:20`, `registerOAuthRoutes`의 callback 오류 분기.

사용자가 지정하는 `error` 쿼리 값을 HTML escaping 없이 `res.send()`에 삽입합니다. 이 분기는 state 검사보다 먼저 실행됩니다.

```text
/api/oauth/callback?error=<공격자가 지정한 HTML>
```

Express의 문자열 응답은 기본적으로 HTML입니다. 따라서 공격 링크를 연 브라우저에서 같은 출처의 스크립트 실행 경로가 생깁니다. HttpOnly 쿠키여도 세션을 이용한 API 요청은 가능합니다.

오류 응답을 명시적으로 `text/plain`으로 보내고, 외부 오류 메시지를 HTML에 직접 넣지 않아야 합니다. 실제 배포의 추가 CSP가 실행을 차단하는지는 확인하지 않았습니다.

## 10. [P1] 사용량 제한은 동시 요청으로 초과할 수 있고, 한 요청이 두 번 차감되기도 합니다

위치: `server/usage.ts:125`, `authorizeInference`, `recordInferenceUsage`; `server/inferenceService.ts:346`, `runEvidenceInference`.

사용량 조회와 기록 사이에 LLM 호출이 있습니다. 잔여량 1회에서 여러 요청이 동시에 조회하면 모두 허가됩니다. 호출 전 예약·트랜잭션·사용자별 동시 실행 제한이 없습니다.

반대로 추론에서는 사용량 기록 후 검증이나 결과 저장이 실패하면 catch가 사용량을 다시 기록합니다. 동일 호출을 식별하는 ID가 없어 두 번 차감됩니다.

호출 전에 원자적으로 예산을 예약하고, 요청 ID를 기준으로 한 번만 정산해야 합니다. 현재는 입력 토큰 예산도 없어 section 전체를 보내는 긴 노트 요청과 짧은 요청이 같은 1회로 계산됩니다.

## 11. [P2] 허용 목록 변경과 로그아웃이 기존 세션을 폐기하지 않습니다

위치: `server/_core/auth.ts:140`, `authenticateRequest`; `server/routers.ts:79`, `auth.logout`.

`ALLOWED_EMAILS`는 로그인 callback에서만 검사합니다. 이미 로그인한 사용자를 허용 목록에서 제거해도 기존 JWT는 최대 30일 동안 작동합니다. 로그아웃도 브라우저 쿠키만 지우므로 복사된 토큰은 유효합니다.

요청 시 허용 상태를 재검사하고 사용자별 세션 버전이나 취소 가능한 세션 저장소가 필요합니다.

별도로 `server/db.ts:85`의 `ownerScope`는 계정으로 가져온 seed 실행에도 기존 guest key 접근을 계속 허용합니다. 공유 브라우저의 이전 key 보유자가 실행을 조회·수정·삭제할 수 있습니다. 계정 귀속 후에는 해당 사용자의 인증을 요구해야 합니다.

## 12. [P2] BYOK 복호화 실패가 운영자 과금으로 조용히 전환됩니다

위치: `server/_core/secrets.ts:47`, `decryptSecret`; `server/usage.ts:125`, `authorizeInference`.

JWT 비밀키를 교체하면 API 키 암호화 키도 바뀝니다. 기존 BYOK 키가 복호화되지 않으면 `null`이 반환되고 운영자 키로 호출됩니다. 설정 화면에는 암호문이 있으므로 여전히 `hasOwnKey: true`입니다.

세션 서명 키와 BYOK 암호화 키를 분리하고, 저장된 키의 복호화 실패는 재등록이 필요한 오류로 처리해야 합니다.

**키 유출은 추정 위험입니다.** `server/_core/llm.ts:244`의 `invokeGemini`는 provider 오류 메시지를 그대로 예외에 넣고, 추론 실패는 이를 `resultJson.error`에 저장해 조회 API로 반환합니다. 정상 설정 API에서 평문 키가 반환되는 경로는 발견하지 못했지만, 외부 오류가 키를 포함할 경우 이를 제거하는 장치는 없습니다.

## 13. [P2] 노트 삭제는 원문 사본 전체의 삭제를 보장하지 않습니다

위치: `server/noteDb.ts:573`, `deleteResearchNote`; `server/storage.ts:99`, `storageDelete`.

R2 삭제 요청은 실제로 수행합니다. 다만 실패하면 key만 기록한 뒤 노트를 삭제합니다. `storage:orphans`는 목록만 출력하며 재삭제 작업을 수행하지 않습니다. 실패한 원문이 계속 남을 수 있습니다.

또한 추론 `resultJson`에 복사된 원문 인용과 `eval/gold`의 원문 snapshot은 노트 삭제로 없어지지 않습니다. `server/goldSet.ts:119`의 `buildGoldCase`는 교정 인용이 원문에 실제 존재하는지도 검사하지 않아, 잘못 입력한 교정문이 평가 기준으로 고정됩니다.

판매 전에는 삭제 재시도 작업, 파생 데이터까지 포함한 삭제 범위, 계정 삭제·내보내기가 필요합니다. 법적 의무의 범위는 판매 지역에 따라 별도 검토해야 하지만, 현재 코드에는 사용자 데이터 전체를 삭제 완료했다고 확인할 수 있는 흐름이 없습니다.

## 가장 위험한 것 3가지

1. **P1 — 근거 없는 답변이 통과하고 평가에서도 만점이 되는 구조.** 핵심 상품 계약을 위반하면서 개선 지표가 결함을 숨깁니다. 심판·화면·평가를 함께 수정해야 합니다.
2. **P1 — OAuth 반사형 XSS.** 공격 링크를 통한 사용자 세션 권한의 API 실행으로 이어질 수 있어 인증과 데이터 격리를 무너뜨립니다.
3. **P1 — 무인증 storage 서명 URL 발급.** 원문 경로가 알려지는 순간 로그인·workspace 소유권 검사 없이 비공개 연구 노트를 읽을 수 있습니다.
