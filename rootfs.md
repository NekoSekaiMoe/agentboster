对，这个需要明确定义。沙箱初始化和 rootfs 来源是 Agent Daemon 沙箱模块的核心配置。

---

## 三种沙箱的初始化

### tmpfs

不需要 rootfs。`mount -t tmpfs` 挂载一个空的内存目录即可。Agent 在空目录里从头开始操作（`git clone`、`npm install` 等）。任务结束 `umount`，数据消失。

---

### Docker

用户必须指定初始镜像。Agent Daemon 的 `SandboxSpec` 里 `Image` 字段必填：

```toml
# agentd.toml 中预设
[sandbox.docker]
default_image = "ubuntu:22.04"        # 默认镜像
allowed_images = [                     # 允许的镜像白名单
    "ubuntu:22.04",
	    "ubuntu:24.04",
		    "alpine:latest",
			    "golang:1.22",
				    "node:20",
					    "python:3.12"
						]
						```
						
						用户创建 Docker 沙箱时可以指定镜像，未指定用默认。出于安全考虑，不允许用 `latest` 以外的任意镜像——白名单限制防止用户拉一个带提权漏洞的恶意镜像。白名单在 `agentd.toml` 中配置，Agent Daemon 启动时加载。
						
						沙箱初始化后，Agent 在容器内执行 `SandboxSpec.Command`（可选初始化命令），然后容器进入可交互状态。
						
						---
						
						### chroot
						
						chroot 需要一个最小化 Linux rootfs。支持三种来源：
						
						**1. 本地预置**
						
						Agent Daemon 首次启动时，自动检查 `{chroot_base}/base/` 目录是否有 Alpine minirootfs。如果没有，Agent Daemon 从内置的默认 URL 下载一次，缓存到本地：
						
						```toml
						[sandbox.chroot]
						chroot_base = "/var/lib/agentd/chroots"
						default_rootfs_url = "https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/x86_64/alpine-minirootfs-3.21.0-x86_64.tar.gz"
						local_rootfs_path = "/var/lib/agentd/images/alpine-minirootfs.tar.gz"  # 本地预置路径
						```
						
						优先级：`local_rootfs_path` 存在 → 直接用本地文件。不存在 → 从 `default_rootfs_url` 下载。
						
						**2. 用户指定 URL**
						
						创建 chroot 沙箱时，用户可以通过 ClawLess 前端或 IM 指定自定义 rootfs URL：
						
						```
						/sandbox create type=chroot rootfs=https://example.com/my-rootfs.tar.gz
						```
						
						Agent Daemon 下载该 URL 的 tar.gz，校验 SHA256（可选），解压到沙箱目录。下载的 rootfs 缓存到 `/var/lib/agentd/images/` 目录，下次创建同 URL 的沙箱时直接用缓存。
						
						**3. 用户指定本地路径**
						
						如果用户已经在服务器上准备了 rootfs（比如自己用 `debootstrap` 构建的 Ubuntu rootfs），可以直接指定本地路径：
						
						```toml
						[[sandbox.chroot.presets]]
						name = "ubuntu-22.04"
						path = "/var/lib/agentd/images/ubuntu-22.04-rootfs"
						```
						
						**沙箱初始化后操作**：chroot 沙箱创建后，Agent Daemon 自动执行初始化脚本（可选），比如安装基础包、配置 DNS、创建 `/workspace` 目录：
						
						```toml
						[sandbox.chroot.init]
						commands = [
						    "apk add --no-cache git curl bash",
							    "mkdir -p /workspace",
								    "echo 'nameserver 8.8.8.8' > /etc/resolv.conf"
									]
									```
									
									初始化完成后，Agent 进入沙箱开始执行任务。
									
									---
									
									## 配置示例
									
									```toml
									[sandbox]
									default = "tmpfs"
									
									[sandbox.tmpfs]
									max_size = "512m"
									
									[sandbox.chroot]
									chroot_base = "/var/lib/agentd/chroots"
									default_rootfs_url = "https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/x86_64/alpine-minirootfs-3.21.0-x86_64.tar.gz"
									local_rootfs_path = "/var/lib/agentd/images/alpine-minirootfs.tar.gz"
									rootfs_cache_dir = "/var/lib/agentd/images/"
									
									[sandbox.chroot.init]
									commands = [
									    "apk add --no-cache git curl bash go",
										    "mkdir -p /workspace"
											]
											
											[[sandbox.chroot.presets]]
											name = "alpine-dev"
											path = "/var/lib/agentd/images/alpine-dev-rootfs"
											
											[[sandbox.chroot.presets]]
											name = "ubuntu-22.04"
											path = "/var/lib/agentd/images/ubuntu-22.04-rootfs"
											
											[sandbox.docker]
											socket = "unix:///var/run/docker.sock"
											default_image = "ubuntu:22.04"
											allowed_images = ["ubuntu:22.04", "ubuntu:24.04", "alpine:latest", "golang:1.22", "node:20", "python:3.12"]
											```
											
											---
											
											## SandboxSpec 的完整结构
											
											```go
											type SandboxSpec struct {
											    Type       string // tmpfs, chroot, docker
												    AgentID    string
													    Persistent bool
														
														    // tmpfs 专用
															    TmpfsMaxSize string // "512m"
																
																    // chroot 专用
																	    RootFSUrl  string // 从 URL 下载 rootfs
																		    RootFSPath string // 使用本地预置 rootfs（优先级最高）
																			    InitCommands []string // 沙箱初始化后执行的命令
																				
																				    // Docker 专用
																					    Image string // Docker 镜像（必填，必须在白名单内）
																						
																						    // 通用
																							    Mounts     []Mount
																								    Env        map[string]string
																									    WorkDir    string // 默认 /workspace
																										}
																										```
																										
																										---
																										
																										## 安全考虑
																										
																										- **URL 下载的 rootfs**：必须校验 SHA256（如果用户提供了校验值）。Agent Daemon 默认只信任 `alpinelinux.org` 域名的下载链接。其他域名需要用户在前端显式确认。
																										- **本地 rootfs**：只允许读取 `{chroot_base}/images/` 目录下的文件，防止用户通过 `../../etc/shadow` 读取宿主机敏感文件。
																										- **Docker 镜像白名单**：硬性限制。用户不能用任意镜像，防止拉取恶意镜像逃逸。管理员可以在 `agentd.toml` 中扩展白名单。
