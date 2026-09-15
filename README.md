# ◐ Mono · 本地动作深度视频

默认在本机生成 **相对深度视频 + 无音频**，用于动作迁移的结构参考。网页与 CLI 共用转换核心；可显式切回普通灰度。模型估计远近关系，不输出米制距离。

- **真实深度推理**：Depth Anything V2 Small，M2 使用 MPS，默认近白远黑。
- **本地处理**：不需要账号，安装完成后可离线运行。
- **两种入口**：浏览器多选/拖拽，或终端单文件、多文件、目录递归转换。
- **可靠批处理**：串行队列、进度、取消、失败重试、暂停后续队列、刷新恢复。
- **原生 FFmpeg**：质量优先使用 libx264；速度优先在可用时使用 VideoToolbox。默认不输出音频。
- **结果可见**：播放导出视频、打开输出位置、查看实际编码器及输出大小。

当前主要验证环境为 macOS。需要 **Node.js 24.x** 和包含 libx264 的 **FFmpeg / ffprobe 6 或更新版本**。Node 层使用原生 JavaScript ES Modules，无构建步骤。深度模式另外需要 Python 3.12 环境及本地模型；普通灰度模式无需 Python。

## 快速开始

已有 Homebrew 的 macOS 用户安装 FFmpeg：

```bash
brew install ffmpeg
```

在项目目录执行：

```bash
# 安装锁定依赖；仅运行应用可加 --omit=dev
npm ci

# 首次准备深度依赖及固定版本模型（需要联网）
npm run setup:depth

# 检查环境，并实际试编码
npm run doctor

# 启动网页工作台
npm start -- --input-dir ./test --output-dir ./output
```

默认监听 `127.0.0.1:3000`，端口占用时自动分配其他端口。终端打印启动链接并自动打开浏览器；使用 `--no-open` 可关闭自动打开。首次打开必须使用终端显示的完整链接，随后同一浏览器可直接刷新。按 `Ctrl+C` 停止服务并取消正在执行的任务。

`test` 中的个人视频被 Git 忽略。新克隆仓库请将 `--input-dir` 替换为真实素材目录，例如：

```bash
npm start -- --input-dir "$HOME/Movies" --output-dir "$HOME/Movies/Grayscale"
```

### 网页操作

1. 在授权目录中勾选视频，或拖拽文件到导入区。
2. 默认是深度视频、无音频；可选择 392/518 推理尺寸、反转深度或切回普通灰度。确认输出目录。
3. 点击开始转换，在队列中查看进度；完成后“播放”或“定位”。

目录直读不复制输入；拖拽会将文件流式复制到 `.grayscale/imports`，需要额外磁盘空间。暂存素材可跨刷新和正常重启恢复。

“暂停队列”只暂停后续任务，当前任务继续完成。“清理已结束”移除已结束任务记录及不再被其他任务引用的暂存副本，**保留原片和导出结果**；清理后的任务不能再从历史记录重试。未进入队列的暂存文件可单独移除。中断上传留下的未登记残留，停止服务后可在 `.grayscale/imports` 人工核查清理。

## 命令行快捷操作

```bash
# 单个视频：默认深度 + 无音频
npm run convert -- test/2026-09-15_153332_222.mp4

# 多个文件
npm run convert -- a.mp4 b.mov --output-dir ./output

# 批量目录，含子目录
npm run convert -- --input-dir ./test --recursive --output-dir ./output

# 更精细深度（更慢）
npm run convert -- video.mp4 --depth-size 518

# 普通灰度，并保留音频
npm run convert -- video.mp4 --mode grayscale --audio auto

# 程序集成：标准输出只有 JSON，错误通过退出码判断
node src/cli.js convert video.mp4 --json

# 帮助
node src/cli.js --help
```

可选：执行 `npm link` 后，可以从任意目录使用 `video-gray convert video.mp4`；网页启动为 `video-gray serve --input-dir ./videos`。

| 参数 | 含义 |
| --- | --- |
| `--input-dir DIR` | CLI 批量输入目录，或网页授权根目录 |
| `--output-dir DIR` | 默认 `./output` |
| `--recursive` | CLI 扫描子目录，忽略隐藏目录、node_modules 和输出目录 |
| `--mode depth\|grayscale` | 默认 depth；普通灰度显式选择 grayscale |
| `--depth-size 392\|518` | 模型推理短边，默认 392；不等于最终输出尺寸 |
| `--depth-device auto\|mps\|cpu` | 默认自动选 MPS 或 CPU；不会无提示从 MPS 重试到 CPU |
| `--invert-depth` | 输出近黑远白，默认近白远黑 |
| `--preset quality\|speed` | 深度模式选择 x264 medium/fast；灰度模式 speed 可用硬件编码 |
| `--audio auto\|aac\|mute` | 默认 mute：不输出音轨；auto 为 AAC 复制、其他音频转 AAC |
| `--json` | CLI 输出结果列表 |
| `--port NUMBER` | 网页端口；0 表示自动分配 |
| `--no-open` | 不自动打开浏览器 |

CLI 串行执行，单个失败后继续其他文件。全部成功退出码为 0，存在失败为 1，Ctrl+C 取消为 130。CLI 不写入网页历史记录。

## 输出与支持范围

- 输出为 H.264、yuv420p、MP4，保留连续灰阶；转换需要重新编码，并非无损。
- 深度输出为 `output/原名-depth-任务ID/depth.mp4`，同时提供 `manifest.json` 与首/中/末帧 PNG。灰度输出为 `原名-gray-任务ID.mp4`；禁止覆盖现有文件。
- 通常保持尺寸与时间轴；奇数尺寸补为偶数，旋转方向由 FFmpeg 正确应用。
- 仅保留首个非封面视频和首条音轨；字幕、附加音轨和章节不保留。默认不复制源文件自定义元数据。
- **HDR / 杜比视界暂不支持**，识别后明确拒绝。未声明色彩信息的素材会给出提醒。
- 目录列表识别 MP4、MOV、MKV、M4V、WebM、AVI；实际能否转换以媒体探测及所安装解码器为准。
- 深度首版支持恒定帧率、方形像素、长宽比不超过 2.5 的 SDR 素材；VFR 或非方形像素需先规范化。逐帧深度可能漂移；分镜头统一范围只能减少归一化引入的闪烁。
- 目前输出使用同文件系统硬链接进行防覆盖提交，输出卷需支持硬链接；建议先输出到本机磁盘，再移动到其他设备。
- 网页只访问启动时授权的目录，不支持任意路径或网络视频 URL。更换根目录需重启。
- 转码中可取消；进入最后的结果提交步骤后等待完成。服务异常退出的任务标记为中断，重试从头开始。
- Windows/Linux 尚未做完整交互验证；不宣传正式跨平台支持。

### 为什么黑白文件反而更大？

源片可能使用 H.265 和较低码率；当前输出使用兼容性较好的 H.264。滤镜改变色彩不等于减少编码体积。质量模式和硬件模式使用不同编码策略，速度与体积都应按实际素材评估。

## 开发与测试

```bash
npm ci
npm run check
npm test
npm run test:browser
# 需要本地模型与指定测试视频：真实深度浏览器验证
node scripts/depth-browser-test.js
```

- `npm test` 生成合成素材，验证灰阶、音轨、尺寸、HDR 拒绝、防覆盖、取消、20 个批量任务、接口鉴权和持久化。
- `test:browser` 使用 Playwright。macOS 默认启动已安装的 Google Chrome；其他环境可设置 `CHROME_PATH` 或先执行 `npx playwright install chromium`。优先使用 `test/2026-09-15_153332_222.mp4`；文件不存在时自动生成合成素材。
- 浏览器测试覆盖真实转换、播放、刷新恢复、拖拽等价文件选择上传、暂停、取消、重试、清理和窄屏布局。截图写入 `output/ui-desktop.png`、`output/ui-mobile.png`。
- `.github/workflows/ci.yml` 定义软件编码与接口测试；配置已添加，远程 CI 尚未运行。

```text
src/cli.js           CLI 和网页启动入口
src/core/            FFmpeg 和深度处理调度、探测、转换、输出校验
python/              离线深度推理、固定版本模型下载
src/server/          受限文件访问、持久队列、HTTP/SSE、鉴权
public/              原生网页界面，无远程静态资源
tests/               真实 FFmpeg 和 HTTP 集成测试
scripts/             语法检查、真实浏览器验证
doc/                 编号规划及实施记录
```

后续优先项：导出前短片试转、更细的质量参数、超大文件与 VFR 专项验证、桌面分发。当前网页提供的是**完成结果播放**，尚未实现导出前短片预览。

本机指定视频的深度效果及测试结果见 [08 深度环境与样本效果](doc/08-深度环境与样本效果.md)。

完整规划见 [文档导航](doc/00-文档导航.md)，本次实测见 [05 实施与测试记录](doc/05-实施与测试记录.md)。
