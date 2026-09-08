import { useState, useEffect } from 'react'
import { Eye, EyeOff, Save, RefreshCw, Trash2 } from 'lucide-react'
import { apiJson, apiPut, apiDelete } from '../../lib/api'

const SECRET_KEY = 'anthropic_api_key'

interface SecretMetadata {
  setAt: string
  expiresAt?: string
}

interface SecretsListResponse {
  secrets: Record<string, SecretMetadata>
}

interface CloudSettingsProps {
  apiHost: string
  spaceId: string
}

export function CloudSettings({ apiHost, spaceId }: CloudSettingsProps) {
  const [workersModel, setWorkersModel] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [existingKeySetAt, setExistingKeySetAt] = useState<string | null>(null)

  useEffect(() => {
    async function loadSecrets() {
      try {
        const status = await apiJson<{ modelProvider?: string; model?: string }>(`${apiHost}/api/runtimes/miriad-cloud/status`).catch(() => null)
        if (status?.modelProvider === 'workers-ai') { setWorkersModel(status.model ?? 'Workers AI'); return }
        const data = await apiJson<SecretsListResponse>(
          `${apiHost}/api/spaces/${spaceId}/secrets`
        )
        const meta = data.secrets[SECRET_KEY]
        if (meta) {
          setExistingKeySetAt(meta.setAt)
        }
      } catch (err) {
        console.error('Failed to load secrets:', err)
      } finally {
        setLoading(false)
      }
    }
    loadSecrets()
  }, [apiHost, spaceId])

  async function handleSave() {
    if (!apiKey.trim()) {
      setError('API key is required')
      return
    }

    setSaving(true)
    setError(null)
    setSaved(false)

    try {
      const result = await apiPut<{ key: string; setAt: string }>(
        `${apiHost}/api/spaces/${spaceId}/secrets/${SECRET_KEY}`,
        { value: apiKey }
      )
      setExistingKeySetAt(result.setAt)
      setApiKey('')
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save API key')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    setDeleting(true)
    setError(null)

    try {
      await apiDelete(`${apiHost}/api/spaces/${spaceId}/secrets/${SECRET_KEY}`)
      setExistingKeySetAt(null)
      setApiKey('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete API key')
    } finally {
      setDeleting(false)
    }
  }

  function formatDate(dateString: string): string {
    const date = new Date(dateString)
    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <RefreshCw className="w-4 h-4 animate-spin" />
        Loading...
      </div>
    )
  }

  if (workersModel) return (
    <div className="space-y-3">
      <h3 className="text-lg font-medium">Miriad Cloud</h3>
      <p>Agents use Cloudflare Workers AI. No model API key is required.</p>
      <p className="text-sm text-muted-foreground">Model: {workersModel}</p>
      <p className="text-sm text-muted-foreground">Start Miriad Cloud from the Runtimes menu. Model usage is billed to your Cloudflare account.</p>
    </div>
  )

  return (
    <div className="space-y-6">
      {/* Error display */}
      {error && (
        <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md text-base text-destructive">
          {error}
        </div>
      )}

      {/* Success display */}
      {saved && (
        <div className="p-3 bg-green-500/10 border border-green-500/20 rounded-md text-base text-green-600">
          API key saved successfully
        </div>
      )}

      {/* Header */}
      <div>
        <h3 className="text-lg font-medium text-foreground">Miriad Cloud</h3>
        <p className="text-base text-muted-foreground mt-1">
          Configure your Claude API key to run agents in Miriad Cloud.
        </p>
      </div>

      {/* API Key input */}
      <div className="space-y-2">
        <label htmlFor="claude-api-key" className="block text-base font-medium text-foreground">
          Claude API Key
        </label>

        {existingKeySetAt ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3 p-3 bg-secondary/30 border border-border rounded-md">
              <div className="flex-1">
                <div className="font-mono text-base">••••••••••••••••••••</div>
                <div className="text-xs text-muted-foreground mt-1">
                  Set on {formatDate(existingKeySetAt)}
                </div>
              </div>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="flex items-center gap-1.5 px-3 py-1.5 text-base text-destructive hover:bg-destructive/10 rounded-md transition-colors disabled:opacity-50"
                title="Remove API key"
              >
                {deleting ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <Trash2 className="w-4 h-4" />
                )}
                Remove
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              To update your API key, remove the existing one and add a new one.
            </p>
          </div>
        ) : (
          <>
            <div className="relative">
              <input
                id="claude-api-key"
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-ant-..."
                className="w-full px-3 py-2 pr-10 bg-secondary/30 border border-border rounded-md text-base placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 hover:bg-secondary rounded transition-colors"
                title={showKey ? 'Hide API key' : 'Show API key'}
              >
                {showKey ? (
                  <EyeOff className="w-4 h-4 text-muted-foreground" />
                ) : (
                  <Eye className="w-4 h-4 text-muted-foreground" />
                )}
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              Get your API key from{' '}
              <a
                href="https://console.anthropic.com/settings/keys"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                console.anthropic.com
              </a>
            </p>

            {/* Save button */}
            <button
              onClick={handleSave}
              disabled={saving || !apiKey.trim()}
              className="flex items-center gap-2 px-4 py-2 text-base bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="w-4 h-4" />
                  Save API Key
                </>
              )}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
