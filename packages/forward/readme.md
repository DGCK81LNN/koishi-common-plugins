# @dgck81lnn/koishi-plugin-forward

[![npm](https://img.shields.io/npm/v/@dgck81lnn/koishi-plugin-forward?style=flat-square)](https://www.npmjs.com/package/@dgck81lnn/koishi-plugin-forward)

fork 自 [koishi-plugin-forward](https://npmjs.com/package/koishi-plugin-forward)

* [X] 修复私聊 bot 可能无法触发其他中间件的问题
* [X] 加载了 assets 服务时，使用它中转附件
* [X] 在支持的平台上用斜体显示 @，并尽量使用群昵称/账号昵称
* [X] 在支持的平台上用粗体显示消息发送者的名称，并尽量使用群昵称/账号昵称
* [X] 使用双书写方向隔离控制字符（`U+2068 FIRST STRONG ISOLATE`、`U+2069 POP DIRECTIONAL ISOLATE`）防止转发消息的文字方向排版错误
* [ ] 处理消息的撤回（删除）与编辑
* [ ] 保留消息的引用（回复）
