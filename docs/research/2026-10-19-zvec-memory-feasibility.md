# Zvec 与 Mem0 可行性核查

核查日期：2026-10-19。范围：为研究提示词提供约束与可证伪假设，未安装依赖、执行数据库实验或修改产品代码。下文区分官方文档事实、工程推断和待验证事项；线上文档、仓库 main 与实际发布包不能互相替代。

## 已核实事实

| 事项 | 证据与边界 |
| --- | --- |
| Zvec 是检索引擎，不自动完成语义编码 | 向量查询接收已有向量；文本如何变成稠密或稀疏向量是另一层。Python 的 `zvec.extension` 提供本地 Sentence Transformers、SPLADE 与 DashText BM25 编码器，也提供在线服务编码器。不能由“进程内向量库”推导出“无需 embedding”。[Embedding 文档](https://zvec.org/zh/docs/db/embedding/) |
| 不用在线 embedding，可以先做纯本地词法检索 | 官方 FTS 文档明确使用 BM25 排序，并允许完全没有向量字段的 FTS-only Collection。Node API 有 `ZVecFtsIndexParams` 与 `ZVecFtsQuery`，支持字符串查询。因此不能误判 Node 必须接在线 embedding 才能使用 Zvec。[FTS 文档](https://zvec.org/en/docs/db/data-operations/query/fts/)、[Node FTS schema](https://zvec.org/api-reference/nodejs/interfaces/ZVecFtsIndexParams.html)、[Node FTS query](https://zvec.org/api-reference/nodejs/interfaces/ZVecFtsQuery.html) |
| Node 与 Python 的扩展层不可直接等同 | 当前 Node API 索引未列出 Python 那套本地 embedding 类；Node FTS schema 列出 standard、ngram、jieba、whitespace 分词器。应分别评估纯 FTS 与独立本地编码器，而不是把 Python 例子原样翻译为 TypeScript。[Node API](https://zvec.org/api-reference/nodejs/index.html)、[Node FTS schema](https://zvec.org/api-reference/nodejs/interfaces/ZVecFtsIndexParams.html) |
| 单进程写入是架构约束 | 官方说明同一 Collection 支持多进程读取，写入单进程独占；持久化使用 WAL。不能据此承诺独立 HTTP 与 REPL 进程同时持有写句柄，也不能推导读进程能与写进程同时打开或自动看见最新写入。[官方概览](https://zvec.org/zh/docs/db/) |
| Node 支持必要的数据生命周期操作 | API 有 insert/upsert/update/delete、deleteByFilter、fetch、query、multiQuery、close、迭代和 schema/index 操作。查询可与标量 filter 组合。写入接口多为同步，查询和 optimize 等存在异步版本；同步大批量操作是否阻塞现有 SSE 要实测。[Collection API](https://zvec.org/api-reference/nodejs/interfaces/ZVecCollection.html)、[查询说明](https://zvec.org/en/docs/db/data-operations/query/) |
| 版本及平台信息有差异 | 核查时 core release 标 v0.7.0 为 Latest，v0.8.0-alpha 为预发布；Node 独立仓库 release 标 v0.7.0，main 的 package.json 已是 0.7.1。Node v0.7.0 列出的预构建包有 macOS ARM64、Linux x64/ARM64（glibc/musl）、Windows x64；main 增加 macOS x64/Windows ARM64。不能把 main 能力直接宣称为指定 npm 包能力。[core releases](https://github.com/alibaba/zvec/releases)、[Node releases](https://github.com/zvec-ai/zvec-node/releases)、[Node v0.7.0 package](https://raw.githubusercontent.com/zvec-ai/zvec-node/v0.7.0/package.json)、[Node main package](https://raw.githubusercontent.com/zvec-ai/zvec-node/main/package.json) |
| 没有查到 Mem0 TS 直接注册 Zvec | 核查的 TS `VectorStoreFactory` 有显式 provider 分支，未见 zvec。其 VectorStore 主接口以 `number[]` 为检索输入，另有可选 keywordSearch；Memory 同时初始化 embedder、LLM 与 vectorStore。换向量库不等于消除 embedding 或写入时模型调用。[工厂源码](https://raw.githubusercontent.com/mem0ai/mem0/main/mem0-ts/src/oss/src/utils/factory.ts)、[接口源码](https://raw.githubusercontent.com/mem0ai/mem0/main/mem0-ts/src/oss/src/vector_stores/base.ts)、[Memory 源码](https://github.com/mem0ai/mem0/blob/main/mem0-ts/src/oss/src/memory/index.ts) |

## 对本项目的推断（待评估，不是实施决定）

- 最小比较应包含“版本约束的精确答案缓存”“BM25 候选召回”“本地稠密编码 + BM25”三条路径。BM25 不产生语义等价保证；语义分数高也不足以直接返回旧答案。应使用负例识别同名函数、不同项目/分支、否定词、金额/时间/资格条件、业务术语近似而答案不同的情况。
- Zvec 可以作为可重建检索索引；反馈、审核状态、版本、证据和原文需要可靠的权威记录。若使用 SQLite，需说明文件持久化模式与 `:memory:` 的差别；不能把进程重启即丢失的内存实例作为长期记录。
- 独立 REPL 与 HTTP 现有部署方式要求研究明确唯一写入所有者、短时间独占打开策略，或可降级的只读路径。简单再加应用文件锁不一定解除数据库已持有的生命周期锁。读写互斥与崩溃恢复应做针对性验证。
- Mem0 适配至少要处理 provider 注册、payload/schema 映射、过滤条件、距离分数方向与阈值、更新/删除/list/历史接口，以及本地 embedder。原生 FTS 路径与以 dense `number[]` 为中心的接口并不完全一致。比较适配 Mem0 与独立小型模块的实际收益，不能默认前者省工。
- 两个值得看原始实现的邻近项目是官方 [zvec-grep](https://github.com/zvec-ai/zvec-grep)（Node 本地编码、BM25/向量/精确匹配组合）与 [ReMe](https://github.com/agentscope-ai/ReMe)（官方 core README 指向其 Zvec 集成）。作为接口和失败处理样本即可，不据此引入额外系统或扩大首期范围。

## 应写进后续研究提示词的验证门槛

1. 明确禁止在线 embedding，但区分“允许一次下载本地模型后离线推理”和“完全不使用 embedding 模型”；若用户尚未选择，分别给出代价，不默认下载。
2. 锁定 npm 包版本、原生绑定版本、Node 版本和目标 OS/CPU。当前 package 未声明 engines，构建文档仅推荐 LTS；npm 站读取 403，registry 与 v0.7.0 类型文件本次未取得，不能宣称已验证可安装性或精确最低 Node 版本。[构建要求](https://zvec.org/en/docs/db/build/node/)
3. 在隔离目录验证：中文/英文/代码标识符检索，过滤隔离，删除及更新后不可召回旧值，重开持久化，多进程争用和崩溃恢复，字典/模型无网络运行，HTTP 输出期间批量索引对延迟的影响。先作为待执行实验，不伪造结果。
4. 用同一固定题集对比现有系统与候选路径。题集至少覆盖完全重复、同义改写、依赖上文、相似但不同答案、代码更新、无答案。分别报告直接复用正确率/误复用率、Recall@k、回答证据正确率、总模型 token、首字与完成延迟、索引/提炼成本和缓存命中率。
5. 不引用厂商“毫秒级/海量规模”的营销指标证明本系统收益；确认成本核算包含 embedding、本地推理、检索、验证、写入整理和模型实际输入/输出。以可复现日志、代码证据与独立人工标注作为裁决，点赞仅作候选信号。
