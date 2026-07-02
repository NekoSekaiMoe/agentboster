import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";

// Monaco Editor 依赖 Web Worker 做语法高亮。Vite ?worker 后缀会把每个 worker 拆成独立 chunk，
// 避免在 Electron 渲染进程里找不到 worker 入口而降级为无高亮的纯文本模式。
// 语言列表按使用频率添加，减少初始 bundle 体积。
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";

export function setupMonaco(): void {
	self.MonacoEnvironment = {
		getWorker(_workerId: string, label: string) {
			switch (label) {
				case "typescript":
				case "javascript":
					return new TsWorker();
				case "json":
					return new JsonWorker();
				case "css":
				case "scss":
				case "less":
					return new CssWorker();
				case "html":
				case "handlebars":
				case "razor":
					return new HtmlWorker();
				default:
					return new EditorWorker();
			}
		},
	};

	loader.config({ monaco });
}
