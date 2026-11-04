# 网关功能修复清单

审计日期：2026-11-03。
用途：跨会话续接网关修复；每项完成后记录改动、实际验证结果，再勾选，不能仅凭编译或测试通过判定完成。

## 续接上下文

- 当前 G05 修复分支：`fix/gateway-g05`，从 G04 提交 `bb3a094` 创建；G02/G03 为 `0144a8a`，G01 为 `27f475c`。这些修复尚未合并至维护分支，未推送。
- 前序已修复：首次新建网关池后编辑器不可见；无池时左侧空栏；上游控件溢出、错位和窄窗口布局。
- 前序新建/布局修复及本清单已通过 `0cd838b` 提交，并快进合并至 `fork/maintenance`，未推送。不要覆盖这些工作或其他用户改动。
- 先前发现 `.codegraph/`、`sync/` 为未跟踪内容，不属于本次修复，不要顺手提交或删除。
- 本清单记录前序审计，不代表后续代码未变化。文件行号均为审计时位置，修复时以符号及当前源码为准。
- G01–G04 已提交；G05 已修复并完成真实 HTTP 烟测、专项、类型检查、全量回归及生产构建验证，随本次提交记录。全量仅保留两项既有 Windows 符号链接 `EPERM` 失败；其余未勾选项保持待修复。

## 证据等级

- **实测确认**：使用真实本地 HTTP 上游、隔离临时目录，或浏览器交互已观察到结果。
- **代码确认**：完整调用链可见，尚未完成该行为的运行复现。
- **静态风险**：需要先运行复现，再决定修复和验收细节。
- G01 修复后，真实 HTTP Chat、Responses、完整 SSE、503 故障切换及认证拒绝均已烟测通过。直接转发层的其他审计问题不因此自动视为修复。

## 第一组：阻断与 Profile 隔离（P1）

### G01 正常 POST 被误判为客户端取消

- [x] 修复请求取消判定，覆盖正常上传、真实断连和响应阶段取消。
- 修复前证据：**实测确认**。正常 POST `/v1/chat/completions`、`/v1/responses` 都返回 499 `Client cancelled request`；本地上游没有收到这两条请求。相同上游通过直接转发调用返回 200。
- 位置：`packages/core/src/gateway.ts`，`GatewayServer.handle`，约 429–450 行。
- 原因：监听 `IncomingMessage` 的 `close`，把正常请求体读取完成也当作客户端取消。
- 验收：真实 HTTP Chat、Responses 均到达上游并返回成功正文；模型被替换为上游模型；正常读完请求体不取消请求；真实客户端断开可终止上游。
- 回归测试须验证状态、正文和上游确实收到请求，不能只断言响应头。
- 修复：改为在响应未完成时收到 `ServerResponse.close` 才取消；下游断连时销毁转发流，并清理关闭监听。
- 回归结果：正常 Chat/Responses、分段上传、等待响应头期间取消、SSE 首帧后取消均通过；安全响应头测试补充成功状态和正文断言，避免把 499 当作成功。

### G02 Profile 切换保留旧草稿，保存可移动原池

- [x] 明确草稿所属 Profile，阻止旧草稿保存到新 Profile。
- [x] 为池的持久化标识建立 Profile 隔离，迁移现有 SQLite/JSON 数据，避免同名 ID 跨 Profile 覆盖。
- 修复前证据：**实测确认**。
  - 在 Default 编辑草稿，切到 Work，页面标题已变为 Work，但仍显示 Default 草稿。
  - SQLite、JSON 后端保存相同池 ID 到 Work 后，Default 的池列表变空。
- 位置：`gateway-module.tsx` 的 Profile effect / `saveDraft`（约 73、100 行）；`electron/metadata-store.ts` 的表结构、`saveGatewayPool`、`listGatewayPools`（约 110、243–258 行）。
- 原因：Profile 变化只刷新列表，未隔离草稿；保存强制使用当前 `profileId`；数据库以池 ID 为全局主键，JSON 同样按 ID 去重。
- 验收：两个 Profile 可各自保存同名池且不互相覆盖；切换 Profile 后旧草稿不能写入新 Profile；迁移前数据保留；健康记录也不能跨 Profile 混合。两个持久化后端均需验证。
- 修复：Profile 切换时重新挂载编辑状态，保存保留草稿原 Profile；列表、健康、探测 IPC 使用显式 Profile。SQLite 改为 `(profile, id)` 联合主键；JSON 按相同联合身份更新。探测记录和保留上限按 Profile 隔离。
- 迁移：保留旧池及健康记录；只能从唯一池所有者推断旧记录归属。无法确定的记录永久隔离，不因后来创建同名池而重新归属；迁移失败显式报错，不降级为空数据。
- 验证：SQLite/JSON 的同名池、更新/重开、旧数据迁移、未归属记录、健康隔离及回滚均有通过的行为回归；浏览器预览已验证 Default→Work→Default 的同名池不覆盖，旧草稿、Token 不串入新页；延迟保存/刷新结果也有 UI 回归。

### G03 运行中保存不会更新活动配置

- [x] 建立明确的保存/应用语义，避免“保存成功”但实际服务继续旧路由。
- 修复前证据：**代码确认**。`gateway:save` 仅调用 `metadata.saveGatewayPool`，未更新活动 `GatewayServer`。
- 位置：`electron/main.ts` 约 480–483 行；`gateway-module.tsx` 的 `saveDraft`、启动/停止按钮。
- 验收：运行中修改虚拟模型、上游、顺序或启用状态后，实际新请求与界面显示的应用状态一致；不再静默继续使用旧配置。端口更改与 G11 一起明确。
- 修复：`GatewayConfigCoordinator` 将保存、启动、停止串行化；保存完成前将同一运行 Profile 的最新启用池应用到服务。不自动启动已停止服务，也不更新其他 Profile 的活动路由。运行中修改端口在持久化前拒绝，要求先停止；G03 阶段的跨 Profile 启动限制已由 G04 同端口原子切换取代。
- 验证：生产保存入口的真实 HTTP 回归与独立烟测确认虚拟模型重命名、上游更换/排序/启停、最后一池禁用后再启用、其他 Profile 保存隔离、停止后保存、端口拒绝及并发操作。

### G04 复用服务时仍保留旧 Profile 的 resolver

- [x] 同步活动池、Profile、供应商解析器及状态归属，不能只替换池列表。
- 修复前证据：**代码确认**。`resolveGatewayForwarder(profileId)` 捕获该 Profile 的配置；已有实例时 `startGateway` 只调用 `gateway.setPools(pools)`，不替换旧 forwarder。
- 位置：`electron/main.ts` 的 `resolveGatewayForwarder`、`startGateway`，约 593–635 行；`GatewayServer` 构造函数。
- 影响：复用实例后可能仍使用旧 Profile 的供应商地址、请求头和凭据引用；界面当前 Profile 与全局运行状态归属不明确。
- 验收：Default/Work 使用相同 provider ID、不同本地上游和测试凭据，切换运行目标后请求只到正确上游；状态明确标识活动 Profile；停止操作的作用对象明确；失败切换不留下错误的状态归属。
- 修复：协调器统一拥有活动实例/端口/Profile；同端口先加载目标 Profile 的 resolver、Token 与池，再同步切换。每个请求在读取正文前捕获池、resolver、历史回调和统计 Map；旧请求的延迟解析或故障切换不会读取新 Profile 的配置，完成后也不会污染当前统计。
- 失败语义：resolver、Token、偏好提交或初次绑定失败不会谎报新归属；已有服务保持原路由。停止必须携带预期活动 Profile，过期页面不能误停切换后的实例。不同端口仍要求先停止（G11），不静默忽略端口。
- 界面：状态显示活动 Profile 与监听地址；无草稿/空 Profile 页面也能明确停止正在运行的 Profile。查看其他 Profile 时隐藏旧 Profile 的统计和 Token；保存、启动、停止通知均标识目标 Profile，失败后刷新实际状态。
- 运行验证发现并修复 JSON 并发提交 `rename EPERM`：元数据写入在持久化边界串行化；网关停止等待请求历史提交完成，防止关闭后继续写入。没有通过重试、吞异常或缩减测试绕过问题。

## 第二组：转发与资源生命周期（P2）

### G05 响应头之后取消与超时失效

- [x] 保持上游响应体生命周期内的取消与超时控制，并在下游断连时释放上游流。
- 证据：**直接转发层实测确认**。真实 SSE 首帧后 abort，超过配置的 40ms，观察至 100ms，上游连接仍未关闭。
- 位置：`gateway.ts` 的 `forwardGatewayRequest` finally（约 250–252 行）、`copyResponse`（约 278–294 行）。
- 原因：fetch 返回响应头后就移除 abort 监听并清除 timer；下游关闭没有配套销毁上游源流。
- G01 已覆盖真实 HTTP 下游断连时销毁上游流；G05 将选定响应的生命周期交给受控响应体，在 EOF、读取错误、调用方取消或超时时释放 reader、timer 与 abort 监听。
- 验收：正常 SSE 可持续读取至 DONE；客户端在首帧后取消能关闭上游；停滞流按明确的超时语义结束；已有响应字节后不切换上游、不重复响应、不产生未处理异常。
- G05 修复前回归：新增 7 项中 5 项失败，真实 HTTP 确认响应头后/首帧后取消、直接转发停滞响应体及 HTTP Chat/Responses 停滞 SSE 都未及时关闭上游。
- 本轮超时语义：每次上游尝试使用空闲期限；收到响应头及每个正文块后重新计时，正常持续输出可跨越多个期限。选定响应后的正文超时/错误只终止当前流，不再次故障切换。

### G06 压缩响应头与正文不匹配

- [ ] 保证转发的 `Content-Encoding` 与实际正文编码一致。
- 证据：**直接转发层实测确认**。gzip 上游经 Node fetch 返回的正文已解压，但头仍是 `gzip`；二次 gunzip 得到 `Z_DATA_ERROR`。
- 位置：`gateway.ts` 的 `RELAYED_RESPONSE_HEADERS`、`copyResponse`（约 25–33、280–283 行）。
- 验收：G01 修复后，通过真实 HTTP 网关请求 gzip 上游，客户端可正常读取 JSON；普通和流式响应不受影响。

### G07 探测及故障切换时未释放丢弃的响应体

- [ ] 先复现连接/响应体是否泄漏，再为被丢弃的响应建立明确的消费或取消路径。
- 证据：**静态风险，尚未运行确认**。probe 只读状态；重试时直接丢弃上一次响应，均未显式消费或取消 body。
- 位置：`gateway.ts` 的 `probeGatewayUpstream`（约 131–138 行）、`forwardGatewayRequest` 的重试分支（约 237–239 行）。
- 复现建议：假上游立即返回 200 或 429 响应头，正文持续不结束；观察探测返回、故障切换后该连接是否释放。
- 验收：探测及重试不会遗留无限响应体或活动连接；最后一个正常返回给客户端的响应仍可读取。

## 第三组：管理流程闭环（P2）

### G08 删除后新增上游产生重复 ID

- [ ] 新增上游生成池内未使用的 ID，并在保存边界拒绝重复 ID。
- 证据：**实测确认**。新增 1、2、3 → 删除 2 → 再新增，结果为 `upstream-1, upstream-3, upstream-3`；React 报 duplicate-key。后端校验实测接受重复 ID。
- 位置：`gateway-module.tsx` 新增按钮（约 287 行）、上游 key；`gateway.ts` 的 `validateGatewayPool`。
- 验收：新增/删除/重排后 ID 始终唯一；每条上游的测速、健康记录和统计保持独立；重复 ID 输入在保存时有明确错误。

### G09 测速没有处理草稿与已保存配置的区别

- [ ] 明确测速使用哪个版本，避免测速未保存的新池，或修改后仍悄悄测速旧配置。
- 证据：**代码确认**。前端传池/上游 ID，主进程只从 metadata 查找已保存对象；新池会报 Unknown gateway pool，新上游会报 Unknown gateway upstream。
- 位置：`gateway-module.tsx` 的 `testProbe`、`probeAll`；`electron/main.ts` 的 `gateway:probe`，约 491–522 行。
- 验收：新建及编辑后的测速行为明确；新上游不因尚未保存而产生误导反馈；全量测速失败不会被简单吞掉并以成功样式误报；结果能对应实际测试的配置版本。

### G10 重新进入页面无法恢复 Token，状态与 Profile 归属不清

- [ ] 为当前运行实例提供可用、归属明确的 Token 获取/显示流程。
- 证据：**UI 实测及代码确认**。启动后显示 Token，离开网关页面再回来消失；组件只在启动返回时设置 token，状态接口没有恢复能力。Profile 切换又可能保留旧 token。
- 位置：`gateway-module.tsx` 的 token state、`refresh`、`start`；`global.d.ts` 的 `gatewayStatus`；`electron/main.ts` 的状态 IPC。
- 验收：应用刷新或重新进入页面时可取得当前运行实例需要的 Token；切换 Profile 不误展示归属错误的运行状态/Token；不把 Token 写入日志或扩大公开接口权限。

### G11 每池端口字段与单监听端口实现不一致

- [ ] 明确端口是服务级还是池级，统一配置模型、UI、校验与运行行为。
- 证据：**代码确认**。每个池都有 `port`，启动只取第一个启用池的端口；已有实例启动时直接返回原绑定端口。
- 位置：`electron/main.ts` 的 `startGateway`（约 609–633 行）、`gateway.ts` 的 `GatewayServer.start`、网关池端口输入框。
- 验收：多个池、不同端口、运行中改端口时，UI 和实际监听地址一致；端口冲突有明确反馈；不再静默忽略配置。
- 设计边界：不要未经决定就增加多监听架构；先明确既有功能应采用的端口语义。

### G12 缺少网关池删除和上游启停管理

- [ ] 补齐池删除的界面与后端闭环，处理运行中删除及健康/凭据引用残留。
- [ ] 提供单条上游 `enabled` 的编辑入口，或明确缩减该字段对用户的承诺。
- 证据：**代码确认的功能缺口**。现有界面只能删除上游，不能删除池；上游有 `enabled` 字段但无启停控件。
- 涉及：`gateway-module.tsx`、`global.d.ts`、`electron/preload.ts`、`electron/main.ts`、`metadata-store.ts`、浏览器 mock。
- 验收：可安全删除不需要的池；最后一个池删除后回到空状态；禁用的上游不参与转发；实际路由同步遵守 G03；删除池不等于删除共享凭据。
- 注意：此项是管理能力补全，不是前序布局修改引入的回归。

## 已验证正常的基线（修复时应保留）

- `/healthz` 与带正确 Token 的 `/v1/models` 返回 200。
- 缺少 Token 返回 401，带浏览器 Origin 返回 403，非回环 Host 返回 421。
- 直接转发层：503 切换下一上游，401 不重试，模型 ID 被替换，基础 SSE 数据和 DONE 可读。
- SQLite、JSON 后端能在关闭/重新打开后保留网关池和健康记录。
- 布局已在 1490、1100、900、760、600px 下观察，无上游控件横向溢出；新增、排序、删除上游可交互。

## 验证要求与已知环境限制

1. 优先完成 G01，再通过真实 HTTP 网关运行 Chat、Responses、SSE、认证及故障切换场景；不能只调用转发函数或 mock API。
2. 手工验证隔离 HOME、USERPROFILE、OMP_SWITCH_DATA_DIR；仅使用本地假上游和测试凭据，不触碰真实模型调用或用户数据。
3. Profile 与持久化问题同时覆盖 SQLite、JSON 后端，关闭存储后再清理 Windows 临时目录。
4. 特别补强正常 POST、跨 Profile、运行中应用、取消、编码等消费者可见行为的回归测试。现有响应头测试未验证成功状态及上游到达，499 也可能通过其断言。
5. 行为变更后按仓库要求运行聚焦测试、`pnpm typecheck`、`pnpm test`、`pnpm build`，并记录真实烟测结果。IPC 变更同步 core（适用时）、main、preload、类型契约和 browser mock。
6. 前序类型检查与构建通过；前序全量测试 415 通过、5 跳过、2 失败。失败均为 `packages/core/src/prompt-library.test.ts` 创建符号链接遭 Windows `EPERM`，不要当作网关回归，也不要为通过检查而删除安全测试。
7. 修复永久行为后更新现有文档/变更记录，移除自己创建的临时脚本，不改无关文件。

## 建议执行顺序

G01 → G02/G04 → G03/G11 → G05/G06/G07 → G08/G09/G10 → G12。

每次续接先读本清单，选择一组明确验收的事项；有前置依赖的事项不要仅做表面 UI 绕过。完成后在下面追加记录并勾选对应任务。

## 完成记录

| 项目 | 改动文件/提交 | 实际验证 | 仍有限制 |
| --- | --- | --- | --- |
| G01 | `27f475c`；`packages/core/src/gateway.ts`、`gateway.test.ts`、`CHANGELOG.md` | 网关专项 19 项通过；类型检查及生产构建通过；全量 420 通过、5 跳过、2 项因既有 Windows 符号链接 EPERM 失败；独立 HTTP 烟测确认 Chat/Responses 200、模型替换、完整 SSE/DONE、503→下一上游 200、无 Token 401、Origin 403 | 直接转发 signal 取消与响应体超时后续由 G05 补齐；其他未勾选项保持待修复 |
| G02 | `0144a8a`；`electron/metadata-store.ts`、`domain.ts`、网关组件、IPC/preload/global/mock 及行为测试 | SQLite/JSON 同名池、旧数据迁移/回滚、永久隔离未知健康记录、重开及 UI 异步切换回归通过；浏览器预览确认同名池往返切换、旧草稿/Token 隔离 | 旧记录无法确定的归属不猜测，保留但不显示于任一有效 Profile |
| G03 | `0144a8a`；`electron/gateway-config.ts`、`electron/main.ts`、网关保存说明及真实 HTTP 测试 | 两个后端通过生产保存入口的真实 HTTP 路由变更、启停、其他 Profile 隔离、端口拒绝、并发保存/启动/停止回归与独立烟测 | 活动端口变化仍须先停止（G11）；跨 Profile 同端口切换已由 G04 完成 |
| G04 | `bb3a094`；`electron/gateway-config.ts`、`main.ts`、核心网关、元数据持久化、IPC/preload/global/mock、网关组件、双语文案及行为测试 | 专项 81 项通过；SQLite/JSON 独立真实 HTTP 确认同 ID 的 A→B→A URL/凭据/请求头隔离、旧请求 503 故障切换归属、当前统计隔离、失败保留旧服务、过期停止拒绝、同 Profile resolver 更新及初次绑定失败不占归属；浏览器确认活动 Profile/停止对象/同端口切换 | 不同端口仍需先停止（G11）；其他未勾选项保持待修复 |
| G05 | `packages/core/src/gateway.ts`、`gateway-response.test.ts`、双语功能文档及变更日志 | 专项 49 项通过，新增 9 项覆盖响应头后/首帧后取消、首字节前/后停滞、Chat/Responses 半途断流、直接取消响应体、上游正文错误与长流；独立 Node 真实 HTTP 确认完整 SSE/DONE、取消/超时关闭上游、无故障切换或第二次响应；生产构建通过 | G06 压缩头及 G07 被丢弃响应的释放仍未处理 |

### G02/G03 本轮验证

- 关联专项与受影响提示词库服务共 **77 项通过**；类型检查、最终生产构建通过。
- 最终全量测试：**440 通过、5 跳过、2 失败**。仅保留既有 `packages/core/src/prompt-library.test.ts` 的 Windows 符号链接 `EPERM`；本轮最初发现的 7 项新目录打开 SQLite 失败已通过在初始化前创建目录修复，未隐藏或跳过测试。
- 独立 Node HTTP 烟测在新建的隔离数据目录中分别使用 SQLite/JSON，确认保存即应用、模型替换、禁用/再启用、不影响其他 Profile、拒绝活动端口更改，以及停止后保存和重开数据保留；临时目录已清理。
- 浏览器预览仅用于 UI 状态切换验证；真实 HTTP 证明来自生产保存协调器和真实网关服务，未声称启动完整 Electron IPC 会话。

### G04 本轮验证

- 最终专项 **81 项通过**；类型检查及生产构建通过。全量 **458 通过、5 跳过、2 失败**，失败仍仅是 `packages/core/src/prompt-library.test.ts` 的既有 Windows 符号链接 `EPERM`。
- 实测发现 JSON 元数据并发提交导致 `rename EPERM`，修复为串行原子提交；随后关闭目录时发现历史写入尚未完成，修复为停止返回前等待写入。保留并发持久化重开、停止后历史可读的行为回归，未跳过失败测试。
- 独立 Node 烟测使用真实网关、两个本地上游及隔离临时数据目录，两个后端均通过；浏览器预览确认查看另一 Profile 时仍明确显示真实运行归属、隐藏其他归属 Token、空页面可停止活动 Profile，以及同端口直接切换。没有声称启动完整 Electron IPC 会话。
- 浏览器及预览服务已关闭，烟测临时目录已清理；没有创建持久化烟测脚本，未触碰 `.codegraph/`、`sync/`。

### G05 本轮验证

- 网关专项 **49 项通过**，其中新增生命周期回归 **9 项**；最终类型检查与生产构建通过。
- 最终全量测试：**467 通过、5 跳过、2 失败**。失败仍仅是 `packages/core/src/prompt-library.test.ts` 的既有 Windows 符号链接 `EPERM`，未修改或跳过这些测试。
- 独立 Node 真实 HTTP 烟测验证：直接及 HTTP SSE 在 400ms 空闲期限下持续约 750ms 并完整读到 DONE；直接调用首帧后取消、响应体停滞，以及 HTTP Chat/Responses 停滞均关闭上游。6 次请求全部只命中第一上游，没有正文开始后的故障切换、追加错误响应或未处理异常。
- 烟测使用进程内脚本和临时回环监听，结束时关闭网关及上游；不读取真实 OMP 配置、不写应用数据、没有持久化烟测脚本，也不涉及 UI 改动。本轮失败测试遗留的四个临时目录已清理；未触碰 `.codegraph/`、`sync/`。
