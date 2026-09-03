import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { KeyRound } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

/**
 * The user's own Gemini key and their remaining monthly quota.
 *
 * A user on their own key is not metered against the shared allowance, which is what makes
 * a free tier possible without the operator underwriting every call. The key is sent once
 * and never returned; only its last four characters come back.
 */
export default function AccountSettingsPanel({
  authenticated,
}: {
  authenticated: boolean;
}) {
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState("");
  const settingsQuery = trpc.account.settings.useQuery(undefined, {
    enabled: authenticated,
  });

  const save = trpc.account.saveApiKey.useMutation({
    onSuccess: async () => {
      setDraft("");
      await utils.account.settings.invalidate();
      toast.success("API 키를 저장했습니다. 이제 본인 키로 추론이 실행됩니다.");
    },
    onError: error => toast.error(error.message),
  });
  const clear = trpc.account.clearApiKey.useMutation({
    onSuccess: async () => {
      await utils.account.settings.invalidate();
      toast.success("API 키를 삭제했습니다. 무료 사용량으로 되돌아갑니다.");
    },
    onError: error => toast.error(error.message),
  });

  if (!authenticated) return null;
  const settings = settingsQuery.data;
  const busy = save.isPending || clear.isPending;

  return (
    <section className="border border-zinc-700 bg-zinc-950/85 p-5">
      <div className="flex items-center gap-3 border-b border-white/15 pb-4">
        <KeyRound className="h-4 w-4 text-zinc-300" />
        <div>
          <p className="meta-face text-[10px] text-zinc-500">API KEY / QUOTA</p>
          <p className="mt-2 text-sm font-extrabold text-zinc-100">
            AI 키와 사용량
          </p>
        </div>
      </div>

      {settings && (
        <div className="mt-4 border border-zinc-800 bg-zinc-900 p-3">
          {settings.hasOwnKey ? (
            <>
              <p className="text-[11px] leading-5 text-zinc-300">
                본인 Gemini 키를 사용 중입니다{" "}
                <span className="font-mono text-zinc-500">
                  (····{settings.keyHint})
                </span>
              </p>
              <p className="mt-1 text-[10px] leading-4 text-zinc-500">
                호출 비용은 본인 Google 계정에 청구되며, 월 사용 제한이
                없습니다.
              </p>
            </>
          ) : (
            <>
              <p className="text-[11px] leading-5 text-zinc-300">
                {settings.plan} 요금제 · 이번 달 {settings.used} /{" "}
                {settings.limit}회 사용
              </p>
              <div className="mt-2 h-1 w-full bg-zinc-800">
                <div
                  className={cn(
                    "h-1",
                    settings.remaining === 0 ? "bg-zinc-500" : "bg-zinc-200"
                  )}
                  style={{
                    width: `${Math.min(100, (settings.used / Math.max(1, settings.limit)) * 100)}%`,
                  }}
                />
              </div>
              <p className="mt-2 text-[10px] leading-4 text-zinc-500">
                {settings.remaining === 0
                  ? "이번 달 사용량을 모두 썼습니다. 아래에 본인 키를 등록하면 계속 사용할 수 있습니다."
                  : "본인 Gemini 키를 등록하면 제한 없이 사용할 수 있습니다."}
              </p>
            </>
          )}
        </div>
      )}

      <div className="mt-4">
        <Input
          type="password"
          value={draft}
          onChange={event => setDraft(event.target.value)}
          placeholder="Gemini API 키 붙여넣기"
          className="h-10 rounded-none border-zinc-700 bg-zinc-900 text-xs text-zinc-100"
        />
        <p className="mt-2 text-[10px] leading-4 text-zinc-600">
          aistudio.google.com에서 발급합니다. 키는 암호화해 저장하며 화면에 다시
          표시하지 않습니다.
        </p>
        <div className="mt-3 flex gap-2">
          <Button
            disabled={draft.trim().length < 20 || busy}
            onClick={() => save.mutate({ apiKey: draft.trim() })}
            className="h-9 flex-1 rounded-none bg-zinc-100 text-xs font-black text-zinc-950 hover:bg-zinc-300"
          >
            키 저장
          </Button>
          {settings?.hasOwnKey && (
            <Button
              disabled={busy}
              onClick={() => clear.mutate()}
              className="h-9 rounded-none border border-zinc-700 bg-transparent text-xs text-zinc-400 hover:border-zinc-500"
            >
              삭제
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
