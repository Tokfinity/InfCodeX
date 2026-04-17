import { FormEvent, useMemo, useState } from 'react'

type FormState = {
  name: string
  phone: string
  company: string
  message: string
}

type FormErrors = {
  name?: string
  phone?: string
}

type SubmitStatus = 'idle' | 'success' | 'error'

const initialForm: FormState = {
  name: '',
  phone: '',
  company: '',
  message: '',
}

const highlights = [
  '7x24 小时智能接待，快速响应客户咨询',
  '标准化收集线索信息，降低人工记录成本',
  '支持从官网展示直达留资表单，适合稳定演示',
]

const validateForm = (form: FormState): FormErrors => {
  const errors: FormErrors = {}

  if (form.name.trim() === '') {
    errors.name = '请输入姓名'
  }

  if (form.phone.trim() === '') {
    errors.phone = '请输入联系电话'
  }

  return errors
}

const simulateSubmit = async (form: FormState) => {
  await new Promise((resolve) => window.setTimeout(resolve, 300))

  if (form.message.toLowerCase().includes('fail')) {
    throw new Error('提交失败，请稍后重试或修改需求描述后再次提交。')
  }
}

export default function App() {
  const [form, setForm] = useState<FormState>(initialForm)
  const [errors, setErrors] = useState<FormErrors>({})
  const [submitStatus, setSubmitStatus] = useState<SubmitStatus>('idle')
  const [feedbackMessage, setFeedbackMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const canSubmit = useMemo(() => {
    return form.name.trim() !== '' && form.phone.trim() !== ''
  }, [form])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const nextErrors = validateForm(form)
    setErrors(nextErrors)
    setSubmitStatus('idle')
    setFeedbackMessage('')

    if (Object.keys(nextErrors).length > 0) {
      setSubmitStatus('error')
      setFeedbackMessage('提交失败，请补全姓名和联系电话后重试。')
      return
    }

    setSubmitting(true)

    try {
      await simulateSubmit(form)
      setSubmitStatus('success')
      setFeedbackMessage('提交成功，我们会尽快与您联系。')
      setForm(initialForm)
      setErrors({})
    } catch (error) {
      setSubmitStatus('error')
      setFeedbackMessage(error instanceof Error ? error.message : '提交失败，请稍后重试。')
    } finally {
      setSubmitting(false)
    }
  }

  const jumpToConsult = () => {
    document.getElementById('consult-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <main className="page-shell">
      <section className="hero-section">
        <div className="hero-copy">
          <span className="eyebrow">InfFlow AI · 官网首页</span>
          <h1>让官网咨询入口更清晰，让线索收集更高效</h1>
          <p className="hero-description">
            面向企业官网场景，集中展示产品标题、核心卖点与明确咨询入口，帮助访客快速了解方案并进入留资流程。
          </p>
          <div className="hero-actions">
            <button type="button" className="primary-button" onClick={jumpToConsult}>
              立即咨询
            </button>
            <a className="secondary-link" href="#consult-form">
              查看留资表单
            </a>
          </div>
        </div>
        <div className="hero-card">
          <h2>核心卖点</h2>
          <ul>
            {highlights.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </section>

      <section className="consult-section" id="consult-form">
        <div className="section-heading">
          <span className="eyebrow">咨询入口</span>
          <h2>提交需求，我们会尽快与您联系</h2>
          <p>表单包含 name、phone、company、message 四个字段，满足首页留资演示的最小闭环。</p>
        </div>

        <form className="consult-form" onSubmit={handleSubmit} noValidate>
          <label>
            联系人姓名 *
            <input
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              placeholder="请输入姓名"
              aria-invalid={Boolean(errors.name)}
            />
            {errors.name ? <span className="field-error">{errors.name}</span> : null}
          </label>
          <label>
            联系电话 *
            <input
              value={form.phone}
              onChange={(event) => setForm((current) => ({ ...current, phone: event.target.value }))}
              placeholder="请输入电话"
              aria-invalid={Boolean(errors.phone)}
            />
            {errors.phone ? <span className="field-error">{errors.phone}</span> : null}
          </label>
          <label>
            公司名称
            <input
              value={form.company}
              onChange={(event) => setForm((current) => ({ ...current, company: event.target.value }))}
              placeholder="请输入公司名称"
            />
          </label>
          <label>
            咨询需求
            <textarea
              rows={4}
              value={form.message}
              onChange={(event) => setForm((current) => ({ ...current, message: event.target.value }))}
              placeholder="请简单描述您的业务场景；输入 fail 可模拟失败提示"
            />
          </label>
          <button type="submit" className="primary-button" disabled={!canSubmit || submitting}>
            {submitting ? '提交中...' : '提交咨询'}
          </button>
          <p className="form-hint">name 与 phone 为必填项；输入 fail 可验证失败提示。</p>
          {submitStatus === 'success' ? <p className="success-message">{feedbackMessage}</p> : null}
          {submitStatus === 'error' ? <p className="error-message">{feedbackMessage}</p> : null}
        </form>
      </section>
    </main>
  )
}
