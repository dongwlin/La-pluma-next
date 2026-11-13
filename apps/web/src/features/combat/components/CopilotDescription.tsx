const DESCRIPTION_URL_PATTERN = /(https?:\/\/[^\s]+)/

export default function CopilotDescription({ text }: { text: string }) {
  return (
    <p className="combat-copilot-detail-description">
      {text.split(DESCRIPTION_URL_PATTERN).map((part, index) => (
        index % 2 === 1
          ? (
              <a
                key={`${index}:${part}`}
                href={part}
                target="_blank"
                rel="noopener noreferrer"
                className="brand-text hover:underline"
              >
                {part}
              </a>
            )
          : part
      ))}
    </p>
  )
}
