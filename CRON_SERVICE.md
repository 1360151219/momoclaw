# CronService - 定时任务调度

MomoClaw 现在支持定时任务功能，可以自动在指定时间执行 AI 任务。

## 功能特性

- **三种调度类型**: Cron 表达式、间隔执行、一次性任务
- **持久化存储**: 任务存储在 SQLite 数据库中，重启不丢失
- **执行日志**: 自动记录每次执行的结果
- **任务管理**: 支持暂停、恢复、删除任务

## 使用方法

### 1. 创建定时任务

```bash
# 一次性任务 (指定 毫秒 时间戳)
miniclaw task:add default -p "总结一下今天的工作" -t once -v "1710524800000"

# 间隔任务 (每 3600 秒 = 1小时执行一次)
miniclaw task:add default -p "检查邮件" -t interval -v 3600

# Cron 任务 (每天上午9点执行)
miniclaw task:add default -p "写日报" -t cron -v "0 9 * * *"
```

### 2. 查看任务列表

```bash
# 查看所有任务
miniclaw task:list

# 查看特定会话的任务
miniclaw task:list mysession
```

### 3. 管理任务

```bash
# 暂停任务
miniclaw task:pause task-xxx

# 恢复任务
miniclaw task:resume task-xxx

# 删除任务
miniclaw task:delete task-xxx

# 查看执行日志
miniclaw task:logs task-xxx -n 5
```

## Cron 表达式格式

格式: `分 时 日 月 周`

| 字段 | 范围 | 说明 |
|------|------|------|
| 分 | 0-59 | 分钟 |
| 时 | 0-23 | 小时 |
| 日 | 1-31 | 日期 |
| 月 | 1-12 | 月份 |
| 周 | 0-6 | 星期 (0=周日) |

### 常用示例

```
* * * * *      # 每分钟
0 * * * *      # 每小时
0 9 * * *      # 每天上午9点
0 9 * * 1-5    # 工作日(周一到周五)上午9点
0 0 * * 0      # 每周日午夜
0 0 1 * *      # 每月1号午夜
```

## 调度类型对比

| 类型 | 用途 | 示例值 |
|------|------|--------|
| `once` | 一次性任务 | `"2024-03-05T18:00:00"` |
| `interval` | 周期性任务 | `3600` (秒) |
| `cron` | 复杂时间规则 | `"0 9 * * 1-5"` |

## 实现细节

- 调度器每分钟检查一次待执行任务
- 任务执行时会自动创建一条用户消息 `[Scheduled Task]\n{prompt}`
- AI 的回复会保存到会话历史
- 执行结果和输出会记录到 `task_run_logs` 表

## 数据库表结构

### scheduled_tasks

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT | 任务唯一标识 |
| session_id | TEXT | 关联的会话ID |
| prompt | TEXT | 执行的提示词 |
| schedule_type | TEXT | cron/interval/once |
| schedule_value | TEXT | 调度值 |
| status | TEXT | active/paused/completed/failed |
| next_run | INTEGER | 下次执行时间戳 |
| last_run | INTEGER | 上次执行时间戳 |
| last_result | TEXT | 上次执行结果 |
| run_count | INTEGER | 执行次数 |

### task_run_logs

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 日志ID |
| task_id | TEXT | 关联的任务ID |
| executed_at | INTEGER | 执行时间戳 |
| success | INTEGER | 是否成功 |
| output | TEXT | 执行输出 |
| error | TEXT | 错误信息 |
