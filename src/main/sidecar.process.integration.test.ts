import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidecar } from './sidecar'

interface ProcessTree {
  child: number
  grandchild: number
}

const fixture = join(
  process.cwd(),
  'sidecar',
  'tests',
  'fixtures',
  'process_owner_sidecar.py',
)
const roots: string[] = []
const sidecars: Sidecar[] = []
const trees: ProcessTree[] = []
let savedOverride: string | undefined

async function readTree(path: string): Promise<ProcessTree> {
  let lastError: unknown
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as ProcessTree
      if (value.child > 1 && value.grandchild > 1) return value
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Publish the process tree before the timeout.')
}

async function processRunning(pid: number): Promise<boolean> {
  try {
    const value = await readFile(`/proc/${pid}/stat`, 'utf8')
    const close = value.lastIndexOf(')')
    const fields =
      close >= 0
        ? value
            .slice(close + 1)
            .trim()
            .split(/\s+/)
        : []
    return fields.length === 0 || fields[0] !== 'Z'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

async function waitForTreeStopped(tree: ProcessTree): Promise<void> {
  await vi.waitFor(
    async () => {
      expect(await processRunning(tree.child)).toBe(false)
      expect(await processRunning(tree.grandchild)).toBe(false)
    },
    { timeout: 8_000, interval: 25 },
  )
}

async function startProvisionFixture(
  sidecar: Sidecar,
  root: string,
  suffix: string,
): Promise<ProcessTree> {
  const ownerPath = join(root, `${suffix}-owner.json`)
  const treePath = join(root, `${suffix}-tree.json`)
  const result = (await sidecar.call('test.startProvision', [
    {
      operationId: `provision-${suffix}`,
      projectId: `project-${suffix}`,
      projectEpoch: 1,
      ownerPath,
      treePath,
    },
  ])) as {
    accepted: boolean
    owner: { operationKind: string; operationId: string; startIdentity: string }
  }
  expect(result).toMatchObject({
    accepted: true,
    owner: {
      operationKind: 'provision',
      operationId: `provision-${suffix}`,
    },
  })
  expect(result.owner.startIdentity).toMatch(/^linux:[^:]+:[1-9]\d*$/)
  const persisted = JSON.parse(await readFile(ownerPath, 'utf8')) as {
    claimId: string
  }
  expect(persisted.claimId).toMatch(/^claim-/)
  const tree = await readTree(treePath)
  trees.push(tree)
  expect(await processRunning(tree.child)).toBe(true)
  expect(await processRunning(tree.grandchild)).toBe(true)
  return tree
}

describe.runIf(process.platform === 'linux')(
  'real process ownership across the main process and sidecar',
  () => {
    beforeEach(async () => {
      savedOverride = process.env['SUPRASPINA_SIDECAR']
      process.env['SUPRASPINA_SIDECAR'] = fixture
      roots.push(await mkdtemp(join(tmpdir(), 'supraspina-process-owner-')))
    })

    afterEach(async () => {
      for (const sidecar of sidecars.splice(0)) {
        await sidecar.stop().catch(() => undefined)
      }
      for (const tree of trees.splice(0)) {
        if (await processRunning(tree.child)) {
          try {
            process.kill(-tree.child, 'SIGKILL')
          } catch {
            // Rely on the bounded assertion that already proved whether cleanup succeeded.
          }
        }
      }
      for (const root of roots.splice(0)) {
        await rm(root, { recursive: true, force: true })
      }
      if (savedOverride === undefined) {
        delete process.env['SUPRASPINA_SIDECAR']
      } else {
        process.env['SUPRASPINA_SIDECAR'] = savedOverride
      }
    })

    it('accepts a durable provision claim before release and cancels its child and grandchild', async () => {
      const sidecar = new Sidecar(process.cwd(), false, {
        callTimeoutMs: 10_000,
        shutdownTimeoutMs: 5_000,
        maxAutomaticRestarts: 0,
      })
      sidecars.push(sidecar)
      await sidecar.start()
      const tree = await startProvisionFixture(sidecar, roots.at(-1)!, 'cancel')

      await expect(sidecar.call('test.cancelProvision', [{}])).resolves.toEqual(
        { terminal: true },
      )

      await waitForTreeStopped(tree)
      await sidecar.stop()
      sidecars.splice(sidecars.indexOf(sidecar), 1)
    }, 20_000)

    it('terminates a provision child and grandchild after the sidecar is SIGKILLed', async () => {
      const sidecar = new Sidecar(process.cwd(), false, {
        callTimeoutMs: 10_000,
        shutdownTimeoutMs: 5_000,
        maxAutomaticRestarts: 0,
      })
      sidecars.push(sidecar)
      await sidecar.start()
      const tree = await startProvisionFixture(sidecar, roots.at(-1)!, 'crash')

      await expect(sidecar.call('test.crash', [{}])).rejects.toThrow(
        /runtime|unavailable/i,
      )
      await vi.waitFor(
        () => expect(sidecar.getState().state).toBe('unavailable'),
        { timeout: 8_000 },
      )

      await waitForTreeStopped(tree)
      await sidecar.stop()
      sidecars.splice(sidecars.indexOf(sidecar), 1)
    }, 20_000)
  },
)
