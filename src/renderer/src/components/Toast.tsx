export interface ToastItem {
  id: number
  kind: 'info' | 'error' | 'success'
  text: string
}

export function ToastStack({ items }: { items: ToastItem[] }) {
  if (!items.length) return null
  return (
    <div className="toast-stack">
      {items.map((item) => (
        <div className="toast" key={item.id} data-kind={item.kind}>
          {item.text}
        </div>
      ))}
    </div>
  )
}
