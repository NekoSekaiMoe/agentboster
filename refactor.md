# AgentClaw 沙箱层重构任务文档

## 概述

将当前的三层沙箱架构（tmpfs / chroot / Docker）重构为两层沙箱架构（Docker / LXC），统一安全约束，消除 chroot 的安全短板，明确轻任务和持久化任务的沙箱定位。

---

## 1. 重构目标

### 当前架构的问题

- tmpfs 轻任务沙箱：文件系统级隔离，Agent 进程可能逃逸访问宿主机文件系统（`cd /home/user`）
- chroot 持久化沙箱：路径隔离，安全边界弱，历史漏洞多
- Docker 强隔离沙箱：内核级隔离，但定位被收窄为"不受信任代码"
- 三种沙箱的安全层级不一致（弱 / 中 / 强），维护三套代码

### 重构后的架构

**Docker**：轻任务 + 不受信任代码
- 非持久化，容器用完即销毁（`docker run --rm`）
- 统一使用 `alpine:edge` 镜像
- 默认 0.25 CPU、256MB 内存，Agent 在创建容器时评估资源需求并指定 `--cpus` 和 `--memory`
- 不支持运行时动态调整 CPU（Docker 限制），内存不足时任务失败通知用户
- Agent Daemon 启动时 `docker pull alpine:edge` 预热镜像，后续容器启动秒级

**LXC**：持久化项目
- 持久化，容器跨 Session 常驻
- 支持自定义发行版和版本（`SandboxSpec.Distro` 和 `SandboxSpec.Release`，默认 `alpine:3.21`）
- 支持 systemd 和完整 init 系统
- 首次创建时从 LXC 模板服务器下载根文件系统，执行 InitCommands 完成初始化
- 后续 Session 通过 `lxc-start` 恢复容器状态，不重复执行 InitCommands
- 支持运行时动态调整 CPU 和内存（cgroup 参数动态生效）
- 项目归档或删除时 `lxc-destroy`

---

## 2. 文件变更清单

### 删除的文件

**`agentd/internal/sandbox/tmpfs.go`**：删除，原 tmpfs 裸挂载实现被 Docker 替代。Docker alpine 容器提供比裸 tmpfs 更强的隔离（namespace + cgroup），且启动速度相当（镜像预热后秒级）。

**`agentd/internal/sandbox/chroot.go`**：删除，原 chroot 路径隔离实现被 LXC 替代。LXC 提供 chroot 做不到的完整 OS 级隔离和 systemd 支持，且根文件系统管理更标准。

### 新增的文件

**`agentd/internal/sandbox/docker_light.go`**：Docker 轻任务沙箱实现。实现 `SandboxProvider` 接口，负责通过 Docker CLI 或 Docker SDK 创建和管理轻任务容器。关键行为：`Create` 方法接收 `SandboxSpec`，解析 `SandboxSpec.CPULimit` 和 `SandboxSpec.MemoryLimit`（若 Agent 未指定则使用默认值 0.25 核 / 256MB），组装 `docker run --rm --cpus=... --memory=... alpine:edge` 命令启动容器；`Exec` 方法通过 `docker exec` 在容器内执行命令；`Destroy` 方法通过 `docker stop` 或 `docker rm -f` 强制销毁容器。容器启动时自动挂载一个 tmpfs 到容器内的 `/workspace/tmp/`，Agent 轻任务在此目录下执行。

**`agentd/internal/sandbox/lxc_persistent.go`**：LXC 持久化沙箱实现。实现 `SandboxProvider` 接口，负责通过 LXC CLI 或 LXC Go 绑定创建和管理持久化容器。关键行为：`Create` 方法首次调用时执行 `lxc-create -t download -n {sandbox_id} -- --dist {SandboxSpec.Distro} --release {SandboxSpec.Release}` 创建容器，然后修改容器配置文件设置 CPU/内存 cgroup 限制，`lxc-start` 启动容器，通过 `lxc-attach` 执行 InitCommands；后续 Session 再次调用 `Create` 时，检测到容器已存在，直接 `lxc-start` 恢复容器状态，不重复执行 InitCommands。`Exec` 方法通过 `lxc-attach` 在容器内执行命令。`Destroy` 方法根据 `SandboxSpec.Persistent` 和用户操作决定：用户选择归档时保留 rootfs 不销毁容器，用户选择删除时执行 `lxc-stop && lxc-destroy` 并删除 rootfs 目录。

### 修改的文件

**`agentd/internal/sandbox/manager.go`**：修改 `SelectSandbox` 函数和 `SandboxManager` 结构体。删除 chroot 和 tmpfs 的选择分支。新的选择逻辑：`SandboxSpec.Persistent == true` 且 `SandboxSpec.Type != "docker"` → 使用 `LXCPersistentProvider`；`SandboxSpec.Persistent == false` 且 `SandboxSpec.Type == "docker"` → 使用 `DockerLightProvider`；`SandboxSpec.Persistent == false` 且 `SandboxSpec.Type` 未指定或为 `auto` → 使用 `DockerLightProvider`。

**`agentd/internal/sandbox/types.go`**：修改 `SandboxSpec` 结构体，新增字段 `Persistent`（`bool`，true 为 LXC 持久化容器）、`Distro`（`string`，LXC 发行版，默认 `alpine`）、`Release`（`string`，LXC 版本，默认 `3.21`）、`InitCommands`（`[]string`，LXC 首次启动后执行的初始化命令列表）、`CPULimit`（`float64`，CPU 核数上限，Docker 默认 0.25，LXC 默认 1.0）、`MemoryLimit`（`int64`，内存上限字节数，Docker 默认 256MB，LXC 默认 512MB）。删除和 chroot 相关的字段（如 `RootFSPath`、`TemplateURL`）。

**`agentd/internal/config/config.go`**：修改沙箱相关配置项。删除 `chroot_base`、`chroot_template_url`、`tmpfs_size`、`tmpfs_mounts` 配置字段。新增 `docker_image`（轻任务默认镜像，默认 `alpine:edge`）、`lxc_default_distro`（LXC 默认发行版，默认 `alpine`）、`lxc_default_release`（LXC 默认版本，默认 `3.21`）、`lxc_rootfs_base`（LXC rootfs 存储路径，默认 `/var/lib/agentd/lxc/`）。

**`agentd/cmd/agentd/main.go`**：修改降权前的初始化步骤。删除 chroot 模板下载和 tmpfs 挂载初始化。新增 Docker 可用性检测：检查 Docker socket 是否可访问（`/var/run/docker.sock`），可访问则 `docker pull alpine:edge` 预热镜像，不可访问则标记 Docker 沙箱不可用。新增 LXC 可用性检测：检查 `lxc-create` 和 `lxc-templates` 是否安装，不可用则标记 LXC 沙箱不可用并在 Web UI 显示"LXC 不可用，仅 Docker 沙箱可用"。

---

## 3. 配置变更

### `agentd.toml` 沙箱 section 变更

**删除的配置项**：
- `[sandbox.tmpfs]` 整个 section（`size`、`mounts`）
- `[sandbox.chroot]` 整个 section（`base_path`、`template_url`）

**新增的配置项**：
- `[sandbox.docker]` section：`image`（轻任务默认镜像，默认 `alpine:edge`）、`default_cpu`（默认 CPU 限制，默认 `0.25`）、`default_memory`（默认内存限制，默认 `256m`）
- `[sandbox.lxc]` section：`default_distro`（默认发行版，默认 `alpine`）、`default_release`（默认版本，默认 `3.21`）、`rootfs_base`（rootfs 存储路径，默认 `/var/lib/agentd/lxc/`）

---

## 4. 接口不变的部分

以下组件不受此次重构影响，不需要修改：

- `SandboxProvider` 接口定义（`Create`、`Exec`、`Destroy` 方法签名不变）
- Agent Loop 的沙箱调用逻辑
- System Prompt 中的沙箱相关描述
- L0/L1/L2 审查链
- ClawLess 端的任务下发和沙箱类型选择 API
- Web UI 的沙箱状态面板（仅更新沙箱类型标签）

---

## 5. 实现步骤

1. 在 `types.go` 中修改 `SandboxSpec` 结构体，新增 `Persistent`、`Distro`、`Release`、`InitCommands`、`CPULimit`、`MemoryLimit` 字段，删除 chroot 相关字段
2. 在 `config.go` 中修改沙箱配置项，删除 chroot 和 tmpfs 配置，新增 Docker 和 LXC 配置
3. 新建 `docker_light.go`，实现 `DockerLightProvider`，完成 `Create`/`Exec`/`Destroy` 方法
4. 新建 `lxc_persistent.go`，实现 `LXCPersistentProvider`，完成 `Create`/`Exec`/`Destroy` 方法
5. 修改 `manager.go`，更新 `SelectSandbox` 的选择逻辑为 Docker/LXC 二选一
6. 修改 `main.go`，更新降权前初始化步骤：删除 chroot 初始化，新增 Docker 镜像预热和 LXC 可用性检测
7. 删除 `tmpfs.go` 和 `chroot.go` 文件
8. 更新 `agentd.toml` 配置示例文件
9. 更新 Web UI 沙箱状态面板的沙箱类型标签（显示 "Docker" 或 "LXC"）
