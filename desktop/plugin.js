import { Button, Input, haptic, host } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useState, useEffect, useRef } from 'react'

const ID = 'vrc-monitor'

function VrcMonitorPane({ ctx }) {
  const [status, setStatus] = useState(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [credState, setCredState] = useState(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [qqmailAuthCode, setQqmailAuthCode] = useState('')
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx

  const fetchStatus = async () => {
    try {
      const res = await ctxRef.current.rest('/status')
      if (res) setStatus(res)
    } catch (e) { /* 静默忽略 */ }
  }

  const fetchCredentials = async () => {
    try {
      const res = await ctxRef.current.rest('/credentials')
      if (res) setCredState(res)
    } catch (e) { /* 静默忽略 */ }
  }

  useEffect(() => {
    fetchStatus()
    const interval = setInterval(fetchStatus, 5000)
    return () => clearInterval(interval)
  }, [])

  const openConfig = async () => {
    setDialogOpen(true)
    setEmail('')
    setPassword('')
    setQqmailAuthCode('')
    await fetchCredentials()
  }

  const saveCredentials = async () => {
    setLoading(true)
    haptic('tap')
    try {
      const body = {}
      if (email !== '') body.email = email
      if (password !== '') body.password = password
      if (qqmailAuthCode !== '') body.qqmail_auth_code = qqmailAuthCode
      const res = await ctxRef.current.rest('/credentials', {
        method: 'POST',
        body,
      })
      if (!res || res.ok === false) {
        host.notify({ kind: 'error', message: `保存失败: ${res?.error || '未知错误'}` })
      } else {
        host.notify({ kind: 'info', message: '凭据保存成功' })
        setDialogOpen(false)
      }
    } catch (e) {
      host.notify({ kind: 'error', message: `保存异常: ${e?.message || e}` })
    } finally {
      setLoading(false)
    }
  }

  const runningText = status
    ? (status.running ? '运行中' : '未运行')
    : '加载中...'

  const configured = credState?.configured
  const emailMasked = credState?.email_masked

  return jsxs('div', {
    className: 'flex h-full flex-col gap-3 p-3 text-sm',
    children: [
      jsx('div', { className: 'font-medium', children: 'VRChat 监控' }),

      jsx('div', {
        className: 'text-(--ui-text-secondary)',
        children: `状态: ${runningText}`
      }),

      jsx('hr', { className: 'border-(--ui-stroke-tertiary)' }),

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
                  jsx('div', { className: 'font-medium', children: '账号配置' }),
                  jsx('button', {
                    type: 'button',
                    className: 'text-(--ui-text-tertiary) hover:text-(--ui-text-primary) text-lg leading-none',
                    onClick: () => setDialogOpen(false),
                    children: '\u2715'
                  })
                ]
              }),

              configured
                ? jsx('div', {
                    className: 'text-(--ui-text-tertiary) text-xs',
                    children: `当前已配置邮箱 ${emailMasked || ''}，密码/授权码留空则保留原值`
                  })
                : jsx('div', {
                    className: 'text-(--ui-text-tertiary) text-xs',
                    children: '请填写三项并保存'
                  }),

              jsxs('div', { className: 'flex flex-col gap-2', children: [
                jsxs('div', { className: 'flex flex-col gap-1', children: [
                  jsx('div', {
                    className: 'text-xs text-(--ui-text-secondary)',
                    children: 'VRChat 邮箱'
                  }),
                  jsx(Input, {
                    placeholder: configured && emailMasked
                      ? `当前邮箱: ${emailMasked}`
                      : '请输入 VRChat 邮箱',
                    value: email,
                    onChange: (e) => setEmail(e.target.value),
                  })
                ]}),

                jsxs('div', { className: 'flex flex-col gap-1', children: [
                  jsx('div', {
                    className: 'text-xs text-(--ui-text-secondary)',
                    children: 'VRChat 密码'
                  }),
                  jsx(Input, {
                    type: 'password',
                    placeholder: '留空则不修改',
                    value: password,
                    onChange: (e) => setPassword(e.target.value),
                  })
                ]}),

                jsxs('div', { className: 'flex flex-col gap-1', children: [
                  jsx('div', {
                    className: 'text-xs text-(--ui-text-secondary)',
                    children: 'QQ 邮箱 IMAP 授权码'
                  }),
                  jsx(Input, {
                    type: 'password',
                    placeholder: '留空则不修改',
                    value: qqmailAuthCode,
                    onChange: (e) => setQqmailAuthCode(e.target.value),
                  })
                ]}),
              ]}),

              jsxs('div', { className: 'flex gap-2', children: [
                jsx(Button, {
                  onClick: saveCredentials,
                  disabled: loading,
                  children: '保存'
                }),
                jsx(Button, {
                  onClick: () => setDialogOpen(false),
                  children: '关闭'
                })
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
      data: {
        placement: 'right',
        dock: { pane: 'files', pos: 'bottom' },
        height: '220px'
      },
      render: () => jsx(VrcMonitorPane, { ctx })
    })
  }
}
