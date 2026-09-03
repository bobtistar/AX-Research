/** `pnpm models` — prints the Forge model catalog so INFERENCE_MODEL can be set to a real ID. */
import { listLLMModels } from "./_core/llm";

listLLMModels()
  .then(catalog => {
    if (!catalog.data.length) {
      console.log("카탈로그가 비어 있습니다.");
      return;
    }
    console.log(`사용 가능한 모델 ${catalog.data.length}개:\n`);
    for (const model of catalog.data) {
      console.log(
        `  ${model.id}${model.owned_by ? `  (${model.owned_by})` : ""}`
      );
    }
    console.log("\n.env에 INFERENCE_MODEL=<위 ID 중 하나> 를 설정하세요.");
  })
  .catch(error => {
    console.error(
      "모델 목록 조회 실패:",
      error instanceof Error ? error.message : error
    );
    process.exitCode = 1;
  });
