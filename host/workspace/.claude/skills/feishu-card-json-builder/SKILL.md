---
name: feishu-card-json-builder
description: |
  根据用户需求生成飞书卡片 JSON 2.0 代码的 skill。
  当用户需要创建飞书卡片、生成飞书卡片 JSON、构建飞书消息卡片、查询飞书卡片格式或者配置的时候触发使用。
  支持生成包含标题、正文、交互组件的完整卡片结构，以及流式更新模式的配置。
---

# 飞书卡片 JSON 2.0 构建器

你是一个飞书卡片 JSON 2.0 专家。根据用户的需求生成符合飞书卡片 JSON 2.0 规范的 JSON 代码。

## 核心概念

### 版本要求
- 卡片 JSON 2.0 支持飞书客户端 7.20 及之后版本
- 必须显式声明 `"schema": "2.0"`
- 最多支持 200 个元素或组件

### 整体结构
```json
{
    "schema": "2.0",
    "config": {},
    "card_link": {},
    "header": {},
    "body": {
        "elements": []
    }
}
```

### 全局配置 (config)
| 字段 | 类型 | 说明 |
|------|------|------|
| streaming_mode | boolean | 是否开启流式更新模式（AI 打字机效果） |
| streaming_config | object | 流式更新配置：print_frequency_ms（频率）、print_step（步长）、print_strategy（fast/delay） |
| summary | object | 卡片摘要，控制聊天栏预览文案 |
| enable_forward | boolean | 是否允许转发，默认 true |
| update_multi | boolean | 是否为共享卡片，JSON 2.0 必须设为 true |
| width_mode | string | 宽度模式：default(600px)/compact(400px)/fill |

### 标题 (header)
```json
{
    "title": {"tag": "plain_text", "content": "主标题"},
    "subtitle": {"tag": "plain_text", "content": "副标题"},
    "text_tag_list": [],
    "template": "blue",
    "icon": {"tag": "standard_icon", "token": "chat-forbidden_outlined", "color": "orange"},
    "padding": "12px"
}
```
- template 支持：blue/wathet/turquoise/green/yellow/orange/red/carmine/violet/purple/indigo/grey/default

### 正文 (body)
布局属性：
- direction: vertical/horizontal（排列方向）
- padding: 内边距，如 "12px 8px"
- horizontal_spacing: 水平间距（small/medium/large/extra_large 或 px 值）
- vertical_spacing: 垂直间距
- horizontal_align: left/center/right
- vertical_align: top/center/bottom

## 组件库

### 容器类组件

#### 1. 分栏 (column_set)
```json
{
    "tag": "column_set",
    "element_id": "column_set_1",
    "horizontal_spacing": "8px",
    "horizontal_align": "left",
    "columns": [
        {
            "tag": "column",
            "width": "weighted",
            "weight": 1,
            "vertical_align": "top",
            "elements": []
        }
    ]
}
```

#### 2. 表单容器 (form)
```json
{
    "tag": "form",
    "element_id": "form_1",
    "elements": [],
    "submit_text": {"tag": "plain_text", "content": "提交"}
}
```

#### 3. 交互容器 (interactive_container)
```json
{
    "tag": "interactive_container",
    "element_id": "container_1",
    "elements": [],
    "behavior": {
        "type": "callback",
        "value": {"key": "value"}
    }
}
```

#### 4. 折叠面板 (collapsible_panel)
```json
{
  "schema": "2.0", // 卡片 JSON 结构的版本。默认为 1.0。要使用 JSON 2.0 结构，必须显示声明 2.0。
  "body": {
    "elements": [
      {
        "tag": "collapsible_panel", // 折叠面板的标签。
        "element_id": "custom_id", // 操作组件的唯一标识。JSON 2.0 新增属性。用于在调用组件相关接口中指定组件。需开发者自定义。
        "direction": "vertical", // 面板内组件的排列方向。JSON 2.0 新增属性。可选值："vertical"（垂直排列）、"horizontal"（水平排列）。默认为 "vertical"。
        "vertical_spacing": "8px", // 面板内组件的垂直间距。JSON 2.0 新增属性。可选值："small"(4px)、"medium"(8px)、"large"(12px)、"extra_large"(16px)或[0,99]px。
        "horizontal_spacing": "8px", // 面板内组件内的垂直间距。JSON 2.0 新增属性。可选值："small"(4px)、"medium"(8px)、"large"(12px)、"extra_large"(16px)或[0,99]px。
        "vertical_align": "top", // 面板内组件的垂直居中方式。JSON 2.0 新增属性。默认值为 top。
        "horizontal_align": "left", // 面板内组件的水平居中方式。JSON 2.0 新增属性。默认值为 left。
        "padding": "8px 8px 8px 8px", // 折叠面板的内边距。JSON 2.0 新增属性。支持范围 [0,99]px。
        "margin": "0px 0px 0px 0px", // 折叠面板的外边距。JSON 2.0 新增属性。默认值 "0"，支持范围 [-99,99]px。
        "expanded": true, // 面板是否展开。默认值 false。
        "background_color": "grey", // 折叠面板的背景色，默认为透明。
        "header": {
          // 折叠面板的标题设置。
          "title": {
            // 标题文本设置。支持 plain_text 和 markdown。
            "tag": "markdown",
            "content": "**面板标题文本**"
          },
          "background_color": "grey", // 标题区的背景色，默认为透明。
          "vertical_align": "center", // 标题区的垂直居中方式。
          "padding": "4px 0px 4px 8px", // 标题区的内边距。
          "position": "top", // 标题区的位置。
          "width": "auto", // 标题区的宽度。默认值为 fill。
          "icon": {
            // 标题前缀图标
            "tag": "standard_icon", // 图标类型.
            "token": "chat-forbidden_outlined", // 图标库中图标的 token。当 tag 为 standard_icon 时生效。
            "color": "orange", // 图标的颜色。当 tag 为 standard_icon 时生效。
            "img_key": "img_v2_38811724", // 自定义前缀图标的图片 key。当 tag 为 custom_icon 时生效。
            "size": "16px 16px" // 图标的尺寸。默认值为 10px 10px。
          },
          "icon_position": "follow_text", // 图标的位置。默认值为 right。
          "icon_expanded_angle": -180 // 折叠面板展开时图标旋转的角度，正值为顺时针，负值为逆时针。默认值为 180。
        },
        "border": {
          // 边框设置。默认不显示边框。
          "color": "grey", // 边框的颜色。
          "corner_radius": "5px" // 圆角设置。
        },
        "elements": [
          // 此处可添加各个组件的 JSON 结构。暂不支持表单（form）组件。
          {
            "tag": "markdown",
            "content": "很长的文本"
          }
        ]
      }
    ]
  }
}
```

下面是一个默认折叠的折叠面板组件：
```json
{
  "schema": "2.0",
  "header": {
    "template": "yellow",
    "title": {
      "tag": "plain_text",
      "content": "折叠面板展示"
    }
  },
  "body": {
    "elements": [
      {
        "tag": "markdown",
        "content": "下面是一个 默认折叠 的折叠面板组件"
      },
      {
        "tag": "collapsible_panel",
        "expanded": false,
        "header": {
          "title": {
            "tag": "plain_text",
            "content": "面板标题文本"
          },
          "vertical_align": "center",
          "icon": {
            "tag": "standard_icon",
            "token": "down-small-ccm_outlined",
            "color": "",
            "size": "16px 16px"
          },
          "icon_position": "right",
          "icon_expanded_angle": -180
        },
        "border": {
          "color": "grey",
          "corner_radius": "5px"
        },
        "vertical_spacing": "8px",
        "padding": "8px 8px 8px 8px",
        "elements": [
          {
            "tag": "markdown",
            "content": "很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本"
          }
        ]
      },
      {
        "tag": "markdown",
        "content": "下面是一个 标题带背景色 且 默认展开 的折叠面板组件"
      },
      {
        "tag": "collapsible_panel",
        "expanded": true,
        "header": {
          "title": {
            "tag": "markdown",
            "content": "**<font color='white'>面板标题文本</font>**"
          },
          "background_color": "yellow",
          "vertical_align": "center",
          "icon": {
            "tag": "standard_icon",
            "token": "down-small-ccm_outlined",
            "color": "white",
            "size": "16px 16px"
          },
          "icon_position": "right",
          "icon_expanded_angle": -180
        },
        "border": {
          "color": "grey",
          "corner_radius": "5px"
        },
        "vertical_spacing": "8px",
        "padding": "8px 8px 8px 8px",
        "elements": [
          {
            "tag": "markdown",
            "content": "很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本"
          }
        ]
      },
      {
        "tag": "markdown",
        "content": "下面是一个无边框折叠面板组件"
      },
      {
        "tag": "collapsible_panel",
        "expanded": true,
        "header": {
          "title": {
            "tag": "markdown",
            "content": "**面板标题文本**"
          },
          "width": "auto_when_fold",
          "vertical_align": "center",
          "padding": "4px 0px 4px 8px",
          "icon": {
            "tag": "standard_icon",
            "token": "down-small-ccm_outlined",
            "color": "",
            "size": "16px 16px"
          },
          "icon_position": "follow_text",
          "icon_expanded_angle": -180
        },
        "vertical_spacing": "8px",
        "padding": "8px 8px 8px 8px",
        "elements": [
          {
            "tag": "markdown",
            "content": "很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本很长的文本"
          }
        ]
      }
    ]
  }
}
```


### 展示类组件

#### 1. 普通文本 (div/plain_text)
```json
{
    "tag": "div",
    "element_id": "text_1",
    "text": {"tag": "plain_text", "content": "文本内容"},
    "icon": {"tag": "standard_icon", "token": "email_outlined"},
    "text_size": "normal",
    "text_color": "default",
    "text_align": "left"
}
```
- text_size: small/normal/medium/large/x_large/xx_large
- text_color: default/primary/secondary/tertiary/link/danger

#### 2. 富文本 (markdown)
```json
{
    "tag": "markdown",
    "element_id": "md_1",
    "content": "**粗体** *斜体* [链接](url)",
    "text_align": "left"
}
```

#### 3. 图片 (img)
```json
{
    "tag": "img",
    "element_id": "img_1",
    "img_key": "img_v2_xxx",
    "alt": {"tag": "plain_text", "content": "描述"},
    "preview": true,
    "scale_type": "fit_horizontal"
}
```

#### 4. 多图混排 (img_combination)
```json
{
    "tag": "img_combination",
    "element_id": "imgs_1",
    "combination_mode": "alternate",
    "corner_radius": "8px",
    "img_list": [
        {"img_key": "img_v2_xxx", "alt": "图片1"}
    ]
}
```

#### 5. 人员 (person)
```json
{
    "tag": "person",
    "element_id": "person_1",
    "open_id": "ou_xxx",
    "show_avatar": true,
    "show_name": true
}
```

#### 6. 人员列表 (person_list)
```json
{
    "tag": "person_list",
    "element_id": "persons_1",
    "persons": [{"id": "ou_xxx", "open_id": "ou_xxx"}],
    "show_avatar": true,
    "show_name": true,
    "max_show_num": 3,
    "show_more_tag": true
}
```

#### 7. 图表 (chart)
```json
{
    "tag": "chart",
    "element_id": "chart_1",
    "chart_spec": {}
}
```
chart_spec 使用 VChart 规范。

#### 8. 表格 (table)
```json
{
    "tag": "table",
    "element_id": "table_1",
    "header": {"show_head": true, "header_style": {"text_align": "center"}},
    "rows": [
        {"cells": [{"tag": "plain_text", "content": "单元格"}]}
    ]
}
```

#### 9. 分割线 (hr)
```json
{"tag": "hr", "element_id": "hr_1"}
```

### 交互类组件

#### 1. 输入框 (input)
```json
{
    "tag": "input",
    "element_id": "input_1",
    "placeholder": {"tag": "plain_text", "content": "请输入"},
    "default_value": "默认值",
    "disabled": false,
    "enter_disabled": false,
    "max_length": 100
}
```

#### 2. 按钮 (button)
```json
{
    "tag": "button",
    "element_id": "btn_1",
    "text": {"tag": "plain_text", "content": "按钮"},
    "type": "primary",
    "size": "medium",
    "disabled": false,
    "behavior": {
        "type": "callback",
        "value": {"action": "submit"}
    }
}
```
- type: primary/default/danger/text
- size: tiny/small/medium/large

#### 3. 折叠按钮组 (overflow)
```json
{
    "tag": "overflow",
    "element_id": "overflow_1",
    "options": [
        {
            "text": {"tag": "plain_text", "content": "选项1"},
            "value": "opt1",
            "multi_select": false
        }
    ]
}
```

#### 4. 下拉单选 (select_static)
```json
{
    "tag": "select_static",
    "element_id": "select_1",
    "placeholder": {"tag": "plain_text", "content": "请选择"},
    "options": [
        {"text": {"tag": "plain_text", "content": "选项"}, "value": "value"}
    ]
}
```

#### 5. 下拉多选 (multi_select_static)
```json
{
    "tag": "multi_select_static",
    "element_id": "multi_select_1",
    "placeholder": {"tag": "plain_text", "content": "可多选"},
    "options": [],
    "max_select_num": 5
}
```

#### 6. 人员单选 (select_person)
```json
{
    "tag": "select_person",
    "element_id": "person_select_1",
    "placeholder": {"tag": "plain_text", "content": "选择人员"}
}
```

#### 7. 人员多选 (multi_select_person)
```json
{
    "tag": "multi_select_person",
    "element_id": "multi_person_1",
    "placeholder": {"tag": "plain_text", "content": "选择多人"},
    "max_select_num": 10
}
```

#### 8. 日期选择器 (date_picker)
```json
{
    "tag": "date_picker",
    "element_id": "date_1",
    "placeholder": {"tag": "plain_text", "content": "选择日期"},
    "initial_date": "2024-01-01"
}
```

#### 9. 时间选择器 (picker_time)
```json
{
    "tag": "picker_time",
    "element_id": "time_1",
    "placeholder": {"tag": "plain_text", "content": "选择时间"},
    "initial_time": "09:00"
}
```

#### 10. 日期时间选择器 (picker_datetime)
```json
{
    "tag": "picker_datetime",
    "element_id": "datetime_1",
    "placeholder": {"tag": "plain_text", "content": "选择日期时间"},
    "initial_datetime": "2024-01-01 09:00:00"
}
```

## 流式更新模式

适用于 AI 场景，实现打字机效果：

```json
{
    "schema": "2.0",
    "config": {
        "streaming_mode": true,
        "streaming_config": {
            "print_frequency_ms": {"default": 70, "android": 70, "ios": 70, "pc": 70},
            "print_step": {"default": 1, "android": 1, "ios": 1, "pc": 1},
            "print_strategy": "fast"
        },
        "summary": {"content": "生成中..."}
    },
    "body": {
        "elements": [
            {
                "tag": "markdown",
                "element_id": "streaming_text",
                "content": ""
            }
        ]
    }
}
```

**流式更新注意事项：**
- print_strategy: fast（新内容立即上屏）或 delay（等历史内容输出完毕）
- 流式更新期间用户交互需要先将 streaming_mode 设为 false
- 10 分钟后自动关闭流式模式

## 工作流程

1. **理解需求**：明确用户需要什么类型的卡片
2. **选择组件**：根据功能需求选择合适的组件
3. **设计布局**：使用容器组件规划布局
4. **添加交互**：为需要的功能添加交互组件
5. **生成 JSON**：输出完整可用的 JSON 代码

## 输出要求

1. 生成的 JSON 必须设置 `"schema": "2.0"`
2. 所有组件必须包含 `element_id`（全局唯一，字母数字下划线，字母开头，≤20字符）
3. 使用有效的 `tag` 值
4. 提供完整可运行的 JSON 代码
5. 简要说明卡片功能和交互逻辑
