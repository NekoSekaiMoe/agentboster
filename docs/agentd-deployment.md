# agentd 部署与降权运维

> `agentd` 是 AgentBoster 的 Linux 执行平面：以 root 启动完成沙箱/cgroup/namespace
> 初始化，随后降权到一个非 root 用户长期运行。本文档讲清楚**如何正确启动、如何降权、
> runtime 目录如何落盘**，以及升级旧版本时要注意的两个坑。
>
> 只适用于 Linux。所有源码带 `//go:build linux`，macOS/Windows 无原生支持
> （macOS 上请用 Lima/Colima 起一个 Linux guest，在 guest 内运行本二进制）。

---

## 一、启动模型：root 起、降权跑

agentd 启动时**必须是真 root**（`main.go` 第一步就检查 `os.Getuid() != 0` 并拒绝），
因为下列初始化需要内核能力：

- cgroup v2 资源计量（读 `/sys/fs/cgroup`）
- seccomp-bpf、Linux capabilities（`--cap-drop ALL` / `no-new-privileges`）
- 绑定 `/var/run` 下的单例锁

完成这些之后，如果配置了 `[security].run_as_user`，进程会 `setgroups → setgid →
setuid` 降到该非 root 用户，长期以低权限运行。降权是可选的但**强烈建议**开启。

启动顺序（`cmd/agentd/main.go`）：

```
1. 检查 root                              ← 非 root 直接 FATAL 退出
2. 加载配置                                ← 见「二、配置从哪来」
3. AcquireSingleton()                     ← 以 root 建 /var/run/agentd/ 并写 pid/sock
4. identity.Resolve()                     ← 以 root 生成/读取 node_id
5. PrepareRuntimeOwnership()              ← 以 root 把 runtime 目录 chown 给 run_as_user
6. DropPrivileges()                       ← 降权到 run_as_user
7. 启动 worker / HTTP / 心跳 ...           ← 已是低权限用户
```

---

## 二、配置从哪来（最容易踩的坑）

`agentd` 用 Viper 加载 TOML。**不带 `-config` 时**，它只在两个位置按名字
`agentd.toml` 搜索：

1. 当前工作目录 `.`
2. `/etc/agentd/`

**关键**：找不到配置文件**不会报错**，而是静默使用内置默认值。默认
`run_as_user = ""`，于是降权被跳过、进程一直以 root 运行，日志里只有一行：

```
[WARN] [DropPrivileges] running as root — no privilege drop (set security.run_as_user to a non-root user)
```

这行 WARN 表示的是「**根本没尝试降权**」，不是「降权失败」。绝大多数
「sudo 跑 agentd 没降权」的问题都出在这里——`sudo ./agentd` 没带 `-config`，
你写的 `agentd.toml` 没被读到。

三种正确做法，任选其一：

```bash
# 方式 A：显式指定配置（sudo 下 ~ 可能解析成 root 家目录，务必用绝对路径）
sudo ./agentd -config /home/user/agentd.toml

# 方式 B：放到标准位置，之后 sudo ./agentd 自动找到
sudo mkdir -p /etc/agentd
sudo cp agentd.toml /etc/agentd/agentd.toml

# 方式 C：环境变量覆盖（sudo 默认清 env，把变量写在命令前透传）
sudo AGENTD_SECURITY_RUN_AS_USER=youruser ./agentd
```

环境变量前缀 `AGENTD_`，格式 `AGENTD_<SECTION>_<KEY>`，可覆盖任意 TOML 项。

---

## 三、配置降权用户

在 `agentd.toml` 里设置：

```toml
[security]
run_as_user = "agentd"   # 一个已存在的非 root 用户
```

`run_as_user` 必须指向**机器上已存在**的用户，否则降权阶段会报
`user "agentd" not found`（agentd 通过 `getent passwd` 解析，支持本地用户和
LDAP）。新建一个专用用户：

```bash
# -r 系统用户，-G docker 让它能访问 docker.sock（若用 Docker 沙箱后端）
sudo useradd -r -s /usr/sbin/nologin -G docker agentd
```

降权成功后日志会变成：

```
[INFO] dropping privileges  user=agentd uid=... gid=... groups=[...]
[INFO] privileges dropped   uid=<非0> gid=<非0>
```

### 降权失败对照表

| 报错前缀 | 根因 | 处置 |
|----------|------|------|
| `user "x" not found` / `groups for user "x" not found` | `run_as_user` 指向的账号不存在 | 建用户，或改成已存在的用户 |
| `setgroups/setgid/setuid: operation not permitted` | 进程缺 `CAP_SETUID`/`CAP_SETGID`——通常是在容器 / user namespace 里跑，不是真 root | 让容器保留这两个 cap，或在已隔离的容器里干脆置空 `run_as_user` 不二次降权 |
| `still root after drop` | 极罕见，异常内核/命名空间 | 同上 |

---

## 四、runtime 目录与所有权

agentd 降权后仍需读写若干目录。**Linux 下删除一个文件需要的是「父目录」的写权限，
而不是文件本身的属主**——这是最隐蔽的坑：单例锁 `agentd.pid` / `agentd.sock`
由 root 在启动时创建，如果它们直接放在 `/var/run`（`root:root 0755`）下，降权后的
用户对 `/var/run` 没有写权限，进程退出时就无法 unlink 自己的 pid 文件：

```
[WARN] failed to remove pid file path=/var/run/agentd.pid error="permission denied"
```

为此，锁文件放在**专用子目录** `/var/run/agentd/` 下，并在降权前由 root 把该目录
（连同 cache、session 目录）`chown` 给 `run_as_user`（`PrepareRuntimeOwnership`）。
这样降权后的用户拥有父目录，unlink 正常。

降权后会被写入、因此都交给 `run_as_user` 拥有的目录：

| 路径 | 内容 | 由哪个配置决定 |
|------|------|----------------|
| `/var/run/agentd/` | `agentd.pid`、`agentd.sock` 单例锁 | 硬编码（不可配） |
| `[cache].path`（默认 `/tmp/agentd`） | `metrics.json`、会话 blob、后台任务存储 | `[cache].path` |
| `[session].store_path`（默认 `/tmp/agentd/sessions`） | 会话状态 | `[session].store_path` |

### `/var/run` 是 tmpfs，重启会清空

`/var/run`（→`/run`）在大多数发行版上是 tmpfs，**重启即清空**。锁文件丢失没关系
（下次启动重建），但如果把需要持久化的东西放这里就会出问题——见下一节的 node_id。

你不需要手动创建 `/var/run/agentd/`——agentd 启动时自己会 `MkdirAll` 并 chown。
systemd 部署时可选地加上 `RuntimeDirectory=agentd`：它让 systemd 在服务停止时
自动清理 `/run/agentd/`（agentd 以 `User=root` 启动，目录初始属主 root，随后由
agentd 在降权前 chown 给 `run_as_user`，两者不冲突）。

---

## 五、node_id 必须落在持久化路径

每个 agentd 节点有一个 `node_id`，用于在 Web 的 `agentd_nodes` 表里标识自己。
**它必须写到持久化磁盘**，否则重启后重新生成，会在 Web 侧留下重复的节点行。

当前默认已经是持久化路径：

```toml
[clawless]
node_id_file = "/var/lib/agentd/node_id"   # 当前默认值，持久化，正确
```

> ⚠️ **升级注意（v0.1.5 及更早）**：v0.1.5（build 2026-07-01）及更早的二进制，
> node_id 默认是 `/var/run/agentd.node_id`——落在 tmpfs 上，**重启即丢，导致重复注册**。
> 该默认值已在提交 `174e466`（2026-07-12）修正为 `/var/lib/agentd/node_id`。
>
> - **推荐**：重新构建部署当前代码，node_id 自动落到 `/var/lib/agentd/`。
> - **若暂时仍用旧二进制**：在 `agentd.toml` 里显式覆盖
>   `node_id_file = "/var/lib/agentd/node_id"`（或环境变量
>   `AGENTD_CLAWLESS_NODE_ID_FILE`），无需重编即可绕过。

首次生成 node_id 发生在降权**之前**（以 root 建目录并写文件），所以
`/var/lib/agentd/` 的首次创建没有权限问题。

---

## 六、快速自查

一键诊断脚本（把 `<USER>` 换成你的 `run_as_user`）：

```bash
U=<USER>
echo "== toml run_as_user =="; grep -n run_as_user /etc/agentd/agentd.toml 2>/dev/null
echo "== 用户是否存在 =="; getent passwd "$U" || echo "NOT FOUND"
echo "== 用户组 =="; id -G "$U" 2>&1
echo "== 是否在容器/userns（非 '0 0 4294967295' 即被映射，非真 root）=="; cat /proc/self/uid_map 2>/dev/null
```

正常降权时，启动日志应包含 `dropping privileges` 和 `privileges dropped uid=<非0>`；
退出时应看到 `singleton lock released`，而**不是** `failed to remove pid file`。

---

## 相关文档

- [`agentd/README.md`](../subpackage/agentd/README.md) — 守护进程完整说明
- [`agentd/agentd.toml.example`](../subpackage/agentd/agentd.toml.example) — 配置模板
- [`self-hosted.md`](self-hosted.md) — Web 层自托管部署
