import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const FILE_NAME_RE = /(?:[^\s，。！？、；;：:]+\.(?:pdf|docx?|xlsx?|pptx?|csv|txt|md|json|html?|png|jpe?g|webp|gif|zip))/iu;
const SEND_INTENT_RE = /(发|发送|传|上传|分享|send|share)/i;
const NO_SEND_INTENT_RE = /(不要|不用|别|无需|先别).{0,8}(发|发送|传|上传|分享|send|share)/i;

export function hasExplicitFeishuFileSendIntent(message: string): boolean {
	const text = message.trim();
	return SEND_INTENT_RE.test(text) && !NO_SEND_INTENT_RE.test(text);
}

export function resolveFeishuFileSendIntent(message: string, cwd: string): string | undefined {
	const text = message.trim();
	if (!hasExplicitFeishuFileSendIntent(text)) return undefined;
	if (!/(文件|飞书|群|发我|给我|给|chat|group)/i.test(text)) return undefined;

	const match = text.match(FILE_NAME_RE);
	if (!match) return undefined;
	const rawPath = match[0].trim();
	const filePath = isAbsolute(rawPath) ? rawPath : join(cwd, rawPath);
	return existsSync(filePath) ? filePath : undefined;
}
