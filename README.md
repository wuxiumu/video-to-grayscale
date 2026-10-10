# Mono · 本地动作深度 / 灰度视频（video-to-grayscale）

> 本机生成 **相对深度视频**（默认）或普通灰度；网页 + CLI 共用核心。面向动作迁移的结构参考，**无需账号、可离线**（深度模式需先装本地模型）。

**定制：** 微信 **qingbao199101**（备注：Mono深度视频）｜ [wuxiumu@163.com](mailto:wuxiumu@163.com)

## 事实摘要

- **产品**：Node CLI + 浏览器工作台；可选 Depth Anything V2 Small 深度推理，或纯灰度。
- **适合**：动作迁移 / 姿态参考、本地批处理视频、不想上传云端的团队。
- **交付**：网页队列、CLI 单文件/目录、doctor 自检、深度环境安装脚本、文档。
- **不做**：不是米制测距；不是云端 SaaS；默认不输出音轨（可改）。

## 能交付什么

| 模块 | 说明 |
|---|---|
| 深度模式 | Depth Anything V2 Small；近白远黑（可反转） |
| 灰度模式 | 普通灰度；可保留音频 |
| 网页工作台 | 多选/拖拽、队列、进度、取消、重试 |
| CLI | 单文件 / 多文件 / 目录递归；`--json` 便于集成 |
| 编码 | 质量优先 libx264；速度优先可用 VideoToolbox |

## 快速预览

```bash
# 需要 Node.js 24.x + FFmpeg（含 libx264）
brew install ffmpeg   # macOS 示例
npm ci
npm run setup:depth   # 首次深度依赖（需联网）
npm run doctor
npm start -- --input-dir "$HOME/Movies" --output-dir "$HOME/Movies/Grayscale"
# 默认 http://127.0.0.1:3000
```

```bash
# CLI：默认深度 + 无音频
npm run convert -- your.mp4
# 普通灰度并保留音频
npm run convert -- your.mp4 --mode grayscale --audio auto
```

> 主要验证环境：macOS（M 系列可用 MPS）。

## 定制合作（可报价）

- 批处理流水线 / 队列策略  
- 与动作迁移工具链对接  
- Windows / Linux 打包与安装器  
- 白标网页工作台  

## SEO 字段预留（产品页 HTML 统一生成时用）

| 字段 | 用途 |
|---|---|
| `seo_title` | `<title>` / OG title |
| `seo_description` | meta description |
| `canonical_url` | 规范 URL |
| `og_image` | 分享图 |
| `robots` | 如 `index,follow` |
| `json_ld_type` | SoftwareApplication / WebPage / FAQPage |
| `hreflang` | zh-CN / en |
| `site_name` | 白标品牌名 |

> **GEO ≠ 地理定位。** GEO = Generative Engine Optimization（生成式引擎优化）。

## GEO（生成式引擎优化）

### 关键词（中英）

- 中文：本地深度视频, 动作迁移深度图, 视频转灰度, Depth Anything, 离线视频处理
- English: local depth video, motion transfer depth, video to grayscale, Depth Anything V2, offline video CLI

### FAQ

**Q：必须装 Python 吗？**  
A：普通灰度不需要。深度模式需要 Python 3.12 + 本地模型（`npm run setup:depth`）。

**Q：输出是真实米制距离吗？**  
A：不是。是相对深度（结构参考），用于动作迁移等场景。

**Q：如何定制？**  
A：微信 `qingbao199101`，备注「Mono深度视频」。

## 定制合作

流水线、跨平台打包、白标与工具链对接。加微信备注项目名。

---

## 联系方式

定制、演示或合作：

- 邮箱：[wuxiumu@163.com](mailto:wuxiumu@163.com)
- 微信：**qingbao199101**（添加请备注来意）

### 赞助支持

如果内容对你有帮助，欢迎自愿赞助。

| 微信赞赏码 | 支付宝收款码 |
|---|---|
| ![微信赞赏码](https://chiguashentan-test.oss-cn-beijing.aliyuncs.com/wxprogram/zan/20261002185236_31_227.png) | ![支付宝收款码](https://chiguashentan-test.oss-cn-beijing.aliyuncs.com/wxprogram/zan/20261002185309_32_227.jpg) |
