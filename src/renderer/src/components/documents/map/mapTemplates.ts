import type { MapBody } from '@shared/types'

// Starter templates for PlexiDiagrams. Each returns a fully positioned MapBody so the
// user begins from something real rather than a blank canvas. Pure data — no
// React Flow, so it is unit-testable and reusable by the AI fallback.

export type MapTemplateId = 'flowchart' | 'orgchart' | 'mindmap' | 'swimlane'

export function mapTemplate(id: MapTemplateId): MapBody {
  switch (id) {
    case 'flowchart':
      return {
        version: 1,
        nodes: [
          { id: 'f1', x: 220, y: 20, label: 'Start', shape: 'terminator', color: '#2563eb' },
          { id: 'f2', x: 215, y: 130, label: 'Do the work', shape: 'process', color: '#2563eb' },
          { id: 'f3', x: 205, y: 240, label: 'Looks good?', shape: 'decision', color: '#d97706' },
          { id: 'f4', x: 40, y: 380, label: 'Fix it', shape: 'process', color: '#dc2626' },
          { id: 'f5', x: 380, y: 380, label: 'Ship it', shape: 'process', color: '#16a34a' },
          { id: 'f6', x: 390, y: 490, label: 'End', shape: 'terminator', color: '#2563eb' }
        ],
        edges: [
          { id: 'fe1', source: 'f1', target: 'f2', style: 'solid' },
          { id: 'fe2', source: 'f2', target: 'f3', style: 'solid' },
          { id: 'fe3', source: 'f3', target: 'f4', label: 'No', style: 'solid' },
          { id: 'fe4', source: 'f3', target: 'f5', label: 'Yes', style: 'solid' },
          { id: 'fe5', source: 'f4', target: 'f2', label: 'retry', style: 'dashed' },
          { id: 'fe6', source: 'f5', target: 'f6', style: 'solid' }
        ],
        viewport: { x: 0, y: 0, zoom: 1 }
      }
    case 'orgchart':
      return {
        version: 1,
        nodes: [
          { id: 'o1', x: 230, y: 30, label: 'CEO', shape: 'process', color: '#7c3aed' },
          { id: 'o2', x: 60, y: 170, label: 'Engineering', shape: 'process', color: '#2563eb' },
          { id: 'o3', x: 230, y: 170, label: 'Product', shape: 'process', color: '#0891b2' },
          { id: 'o4', x: 400, y: 170, label: 'Sales', shape: 'process', color: '#16a34a' }
        ],
        edges: [
          { id: 'oe1', source: 'o1', target: 'o2', style: 'solid' },
          { id: 'oe2', source: 'o1', target: 'o3', style: 'solid' },
          { id: 'oe3', source: 'o1', target: 'o4', style: 'solid' }
        ],
        viewport: { x: 0, y: 0, zoom: 1 }
      }
    case 'mindmap':
      return {
        version: 1,
        nodes: [
          { id: 'm0', x: 240, y: 180, label: 'Idea', shape: 'circle', color: '#7c3aed' },
          { id: 'm1', x: 60, y: 60, label: 'Why', shape: 'note', color: '#2563eb' },
          { id: 'm2', x: 440, y: 60, label: 'Who', shape: 'note', color: '#0891b2' },
          { id: 'm3', x: 60, y: 320, label: 'How', shape: 'note', color: '#16a34a' },
          { id: 'm4', x: 440, y: 320, label: 'When', shape: 'note', color: '#d97706' }
        ],
        edges: [
          { id: 'me1', source: 'm0', target: 'm1', style: 'solid' },
          { id: 'me2', source: 'm0', target: 'm2', style: 'solid' },
          { id: 'me3', source: 'm0', target: 'm3', style: 'solid' },
          { id: 'me4', source: 'm0', target: 'm4', style: 'solid' }
        ],
        viewport: { x: 0, y: 0, zoom: 1 }
      }
    case 'swimlane':
      return {
        version: 1,
        nodes: [
          // Three horizontal lanes, one per role, with the steps flowing across.
          { id: 'lane1', x: 0, y: 0, width: 780, height: 150, label: 'Requester', shape: 'lane', color: '#2563eb' },
          { id: 'lane2', x: 0, y: 160, width: 780, height: 150, label: 'Approver', shape: 'lane', color: '#d97706' },
          { id: 'lane3', x: 0, y: 320, width: 780, height: 150, label: 'System', shape: 'lane', color: '#16a34a' },
          { id: 's1', x: 60, y: 52, label: 'Request', shape: 'terminator', color: '#2563eb' },
          { id: 's2', x: 220, y: 50, label: 'Submit form', shape: 'data', color: '#2563eb' },
          { id: 's4', x: 430, y: 52, label: 'Send back', shape: 'process', color: '#dc2626' },
          { id: 's3', x: 250, y: 208, label: 'Approved?', shape: 'decision', color: '#d97706' },
          { id: 's5', x: 430, y: 372, label: 'Record', shape: 'database', color: '#16a34a' },
          { id: 's6', x: 620, y: 378, label: 'Done', shape: 'terminator', color: '#16a34a' }
        ],
        edges: [
          { id: 'se1', source: 's1', target: 's2', style: 'solid' },
          { id: 'se2', source: 's2', target: 's3', style: 'solid' },
          { id: 'se3', source: 's3', target: 's4', label: 'No', style: 'solid' },
          { id: 'se4', source: 's3', target: 's5', label: 'Yes', style: 'solid' },
          { id: 'se5', source: 's4', target: 's2', label: 'revise', style: 'dashed' },
          { id: 'se6', source: 's5', target: 's6', style: 'solid' }
        ],
        viewport: { x: 0, y: 0, zoom: 1 }
      }
  }
}
