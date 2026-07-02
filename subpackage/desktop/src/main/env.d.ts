/// <reference types="vite/client" />

// electron-vite 的 ?asset 后缀类型声明
// 使用 ?asset 导入时，Vite 会将文件复制到输出目录并返回正确的运行时路径
declare module "*?asset" {
	const value: string;
	export default value;
}
