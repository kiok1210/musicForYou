interface VinylStageProps {
  cover: string | null
  playing: boolean
}

/**
 * 黑胶唱片本体。
 * 沟槽层跟随播放旋转，反光层保持静止——这是让唱片"像真的"的关键。
 */
export function VinylStage({ cover, playing }: VinylStageProps) {
  const spinning = playing && Boolean(cover)

  return (
    <div className="vinyl-stage" data-playing={spinning}>
      <div className="vinyl-shell" data-playing={spinning}>
        <div className="vinyl-disc">
          <div
            className="vinyl-label"
            style={cover ? { backgroundImage: `url("${cover}")` } : undefined}
          >
            {cover ? null : <span className="vinyl-label-empty">No Disc</span>}
          </div>
        </div>
        <div className="vinyl-light" />
        <div className="tonearm">
          <svg viewBox="0 0 64 320" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="vb-rod" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stopColor="#17171d" />
                <stop offset="0.3" stopColor="#6c6c79" />
                <stop offset="0.5" stopColor="#b6b6c2" />
                <stop offset="0.72" stopColor="#4c4c57" />
                <stop offset="1" stopColor="#141419" />
              </linearGradient>
              <radialGradient id="vb-pivot" cx="0.34" cy="0.3" r="0.8">
                <stop offset="0" stopColor="#86868f" />
                <stop offset="0.55" stopColor="#33333c" />
                <stop offset="1" stopColor="#141419" />
              </radialGradient>
              <linearGradient id="vb-head" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#4c4c58" />
                <stop offset="0.65" stopColor="#1c1c22" />
                <stop offset="1" stopColor="#0a0a0e" />
              </linearGradient>
            </defs>
            {/* 配重 */}
            <rect x="21" y="0" width="22" height="16" rx="5" fill="url(#vb-rod)" />
            {/* 转轴 */}
            <circle cx="32" cy="28" r="17" fill="url(#vb-pivot)" />
            <circle cx="32" cy="28" r="6.5" fill="#0f0f13" />
            {/* 臂杆 */}
            <path d="M32 42 L35.6 250 L28.4 250 Z" fill="url(#vb-rod)" />
            {/* 唱头 */}
            <rect x="17" y="246" width="30" height="30" rx="6" fill="url(#vb-head)" />
            {/* 唱针 */}
            <path d="M32 276 L32 291" stroke="#dcdce4" strokeWidth="2" strokeLinecap="round" />
            <circle cx="32" cy="293.5" r="2.2" fill="#eeeef4" />
          </svg>
        </div>
      </div>
    </div>
  )
}
