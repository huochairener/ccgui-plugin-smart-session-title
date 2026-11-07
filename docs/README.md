# 展示素材（市场图标与效果图）

- `icon.svg` —— 市场列表图标（矢量，512×512 viewBox，已在 `manifest.json` 的 `icon` 字段声明）。
- `screenshot-1.png` / `screenshot-2.png` / `screenshot-3.png` —— **待补**：详情页效果图。

## 补截图的步骤

插件市场详情页最多展示 5 张图，数组顺序 = 展示顺序。建议拍这三张：

1. 侧边栏会话列表，标题已带上 emoji 前缀（体现核心效果）
2. 插件设置页（命名方式 / 引擎 / 模型 / 标题语言 / 最大长度 / 测试完整链路）
3. 右下角状态栏的 `✦ 会话命名中…` 或 `✓ 已命名：xxx` 提示

拍好后把文件放到本目录（PNG / JPG / WebP，宽度 ≥ 800 更清晰），然后：

1. 在 `manifest.json` 加一行：

   ```json
   "screenshots": ["docs/screenshot-1.png", "docs/screenshot-2.png", "docs/screenshot-3.png"]
   ```

2. 在索引仓的 `plugins/smart-session-title.json` 里加同样的 `screenshots` 数组；
3. 提一个**只改这两个文件的素材 PR**（不改 version）。素材属于用户可见内容，
   不走「版本登记自动合并」，会转人工审核。

> 图片按插件仓库默认分支读取，**替换同名文件不需要发版**；换文件名则随下一次发版进索引。
> CI 只校验素材路径格式（图片扩展名、不逃逸仓库、≤ 5 张），不校验文件是否已存在，
> 所以路径先声明、文件后补也不会挂，但客户端会拉不到图而回退成首字母瓷砖——补完再提 PR 更好。
