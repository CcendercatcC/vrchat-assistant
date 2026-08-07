import { Button, haptic, host } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useState, useEffect, useRef } from 'react'

const ID = 'vrc-monitor'

function VrcMonitorPane({ ctx }) {
  const [status, setStatus] = useState(null)
  const [doctor, setDoctor] = useState(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx

  const fetchStatus = async () => {
    try {
      const res = await ctxRef.current.rest('/status')
      if (res) setStatus(res)
    } catch (e) { /* 静默忽略 */ }
  }

  const fetchDoctor = async () => {
    try {
      const res = await ctxRef.current.rest('/doctor')
      if (res) setDoctor(res)
    } catch (e) { /* 静默忽略 */ }
  }

  useEffect(() => {
    fetchStatus()
    const interval = setInterval(fetchStatus, 5000)
    return () => clearInterval(interval)
  }, [])

  const doAction = async (action) => {
    setLoading(true)
    haptic('tap')
    try {
      const res = await ctxRef.current.rest(`/${action}`, { method: 'POST' })
      if (!res || res.ok === false) {
        host.notify({ kind: 'error', message: `${action} 失败: ${res?.error || '未知错误'}` })
      } else {
        host.notify({ kind: 'info', message: `${action} 成功` })
      }
      await fetchStatus()
    } catch (e) {
      host.notify({ kind: 'error', message: `${action} 异常: ${e?.message || e}` })
    } finally {
      setLoading(false)
    }
  }

  const openConfig = async () => {
    setDialogOpen(true)
    await fetchDoctor()
  }

  const statusText = status
    ? (status.running ? '运行中' : '已停止')
    : '加载中...'

  return jsxs('div', {
    className: 'flex h-full flex-col gap-3 p-3 text-sm',
    children: [
      jsx('div', { className: 'font-medium', children: 'VRChat 监控' }),

      jsxs('div', { className: 'flex flex-col gap-1', children: [
        jsx('div', {
          className: 'text-(--ui-text-secondary)',
          children: `状态: ${statusText}`
        }),
        status && status.pid && jsx('div', {
          className: 'text-(--ui-text-tertiary)',
          children: `PID: ${status.pid}`
        }),
        status && status.health && !status.health.error && jsx('div', {
          className: 'text-(--ui-text-tertiary)',
          children: `健康: ${JSON.stringify(status.health)}`
        }),
        status && status.resolved && jsxs('div', {
          className: 'text-(--ui-text-tertiary) flex flex-col gap-0.5',
          children: [
            jsx('div', {
              children: `服务目录: ${status.resolved.monitor_dir || '未解析'}`
            }),
            jsx('div', {
              children: `Node.js: ${status.resolved.node_exe || '未解析'}`
            })
          ]
        })
      ]}),

      jsxs('div', { className: 'flex gap-2', children: [
        jsx(Button, {
          onClick: () => doAction('start'),
          disabled: loading,
          children: '启动'
        }),
        jsx(Button, {
          onClick: () => doAction('stop'),
          disabled: loading,
          children: '停止'
        }),
        jsx(Button, {
          onClick: () => doAction('restart'),
          disabled: loading,
          children: '重启'
        })
      ]}),

      jsx('hr', { className: 'border-(--ui-border)' }),

      jsx(Button, { onClick: openConfig, children: '配置' }),

      dialogOpen && jsxs('div', {
        className: 'fixed inset-0 z-50 flex items-center justify-center bg-(--ui-bg-elevated)/40',
        onClick: () => setDialogOpen(false),
        children: [
          jsxs('div', {
            className: 'bg-(--ui-bg-elevated) rounded-lg shadow-lg p-4 max-w-md w-full mx-4 flex flex-col gap-3 border border-(--ui-stroke-tertiary)',
            onClick: (e) => e.stopPropagation(),
            children: [
              jsxs('div', {
                className: 'flex items-center justify-between',
                children: [
                  jsx('div', { className: 'font-medium', children: '配置检查' }),
                  jsx('button', {
                    type: 'button',
                    className: 'text-(--ui-text-tertiary) hover:text-(--ui-text-primary) text-lg leading-none',
                    onClick: () => setDialogOpen(false),
                    children: '\u2715'
                  })
                ]
              }),

              doctor && doctor.checks
                ? jsxs('div', { className: 'flex flex-col gap-2', children: [
                    ...doctor.checks.map((check, i) =>
                      jsxs('div', {
                        key: i,
                        className: 'flex items-start gap-2',
                        children: [
                          jsx('span', {
                            className: check.ok ? 'text-(--ui-green)' : 'text-(--ui-red)',
                            children: check.ok ? '\u2713' : '\u2717'
                          }),
                          jsxs('div', { className: 'flex flex-col', children: [
                            jsx('span', { children: check.name }),
                            jsx('span', {
                              className: 'text-(--ui-text-tertiary) text-xs',
                              children: check.detail || ''
                            })
                          ]})
                        ]
                      })
                    )
                  ]})
                : jsx('div', {
                    className: 'text-(--ui-text-tertiary)',
                    children: '加载中...'
                  }),

              jsx('div', {
                className: 'text-(--ui-text-tertiary) text-xs',
                children: '配置说明请查看仓库根目录 AGENTS.md，让 AI Agent 自动完成配置'
              }),

              jsxs('div', { className: 'flex gap-2', children: [
                jsx(Button, { onClick: fetchDoctor, children: '重新检测' }),
                jsx(Button, { onClick: () => setDialogOpen(false), children: '关闭' })
              ]})
            ]
          })
        ]
      })
    ]
  })
}

export default {
  id: ID,
  name: 'VRChat Monitor',
  register(ctx) {
    ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'VRChat Monitor',
      data: { placement: 'right' },
      render: () => jsx(VrcMonitorPane, { ctx })
    })
  }
}
