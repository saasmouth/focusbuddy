// Network and device icons (vendor-neutral). Each is an icon tile with the
// label underneath; the icon is a Material Symbols name (verified against the
// installed material-symbols package by tests/unit/diagramShapes.test.ts) that
// the user can swap per node. Ids are saved in documents — never rename.

import { type ShapeDef } from './types'
import { iconShape } from './kit'

const N = 'Network' as const
const net = (id: string, label: string, icon: string, keywords: string[]): ShapeDef =>
  iconShape(`net-${id}`, label, N, icon, ['network', 'device', ...keywords])

export const NETWORK_SHAPES: ShapeDef[] = [
  net('server', 'Server', 'dns', ['server', 'host', 'machine', 'rack server', 'backend']),
  net('database-server', 'Database server', 'database', ['database', 'db', 'server', 'sql', 'data']),
  net('web-server', 'Web server', 'web', ['web server', 'server', 'http', 'website', 'frontend']),
  net('mail-server', 'Mail server', 'mail', ['mail server', 'email', 'smtp', 'server', 'exchange']),
  net('desktop', 'Desktop', 'desktop_windows', ['desktop', 'pc', 'computer', 'workstation', 'client']),
  net('laptop', 'Laptop', 'laptop_mac', ['laptop', 'notebook', 'computer', 'client', 'portable']),
  net('phone', 'Mobile phone', 'mobile', ['phone', 'mobile', 'smartphone', 'cell', 'handset']),
  net('tablet', 'Tablet', 'tablet_mac', ['tablet', 'ipad', 'slate', 'mobile device']),
  net('ip-phone', 'Desk phone', 'call', ['ip phone', 'voip', 'telephone', 'desk phone', 'call']),
  net('router', 'Router', 'router', ['router', 'gateway', 'routing', 'edge']),
  net('switch', 'Switch', 'lan', ['switch', 'lan', 'ethernet', 'hub', 'layer 2']),
  net('hub', 'Hub', 'device_hub', ['hub', 'concentrator', 'splitter', 'topology']),
  net('firewall', 'Firewall', 'local_fire_department', ['firewall', 'security', 'filter', 'perimeter', 'utm']),
  net('wifi-ap', 'Wi-Fi access point', 'wifi', ['wifi', 'wireless', 'access point', 'wlan', 'ap']),
  net('modem', 'Modem', 'nest_wifi_router', ['modem', 'broadband', 'isp', 'cable modem', 'dsl']),
  net('printer', 'Printer', 'print', ['printer', 'print', 'peripheral', 'mfp']),
  net('user', 'User', 'person', ['user', 'person', 'client', 'customer', 'people']),
  net('users', 'Users', 'group', ['users', 'group', 'team', 'people', 'audience']),
  net('internet', 'Internet', 'public', ['internet', 'globe', 'world', 'web', 'wan', 'www']),
  net('cloud', 'Cloud network', 'cloud', ['cloud', 'network', 'saas', 'hosted', 'offsite']),
  net('load-balancer', 'Load balancer', 'alt_route', ['load balancer', 'lb', 'balancer', 'traffic', 'distribution', 'proxy']),
  net('storage', 'Storage array', 'storage', ['storage', 'san', 'array', 'disk', 'server']),
  net('nas', 'NAS', 'hard_drive', ['nas', 'network attached storage', 'file server', 'disk', 'drive']),
  net('rack', 'Rack', 'shelves', ['rack', 'cabinet', 'data centre', 'data center', 'server rack']),
  net('satellite', 'Satellite', 'satellite_alt', ['satellite', 'space', 'uplink', 'vsat', 'gps']),
  net('cell-tower', 'Cell tower', 'cell_tower', ['cell tower', 'mobile network', '4g', '5g', 'lte', 'antenna', 'base station']),
  net('cctv', 'CCTV camera', 'videocam', ['cctv', 'camera', 'surveillance', 'security camera', 'ip camera']),
  net('iot', 'IoT device', 'sensors', ['iot', 'sensor', 'smart device', 'embedded', 'internet of things']),
  net('terminal', 'Terminal', 'terminal', ['terminal', 'console', 'shell', 'cli', 'ssh', 'command line']),
  net('mainframe', 'Mainframe', 'memory', ['mainframe', 'legacy', 'host', 'cpu', 'chip']),
  net('tv', 'Smart TV / display', 'tv', ['tv', 'display', 'screen', 'signage', 'monitor']),
  net('building', 'Office / site', 'corporate_fare', ['office', 'building', 'site', 'branch', 'campus', 'hq']),
  net('home', 'Home office', 'home', ['home', 'remote', 'house', 'residential']),
  net('data-center', 'Data center', 'domain', ['data centre', 'data center', 'facility', 'colocation', 'dc']),
  net('cable', 'Cable / link', 'cable', ['cable', 'link', 'wire', 'fibre', 'fiber', 'patch']),
  net('keyboard', 'Keyboard', 'keyboard', ['keyboard', 'input', 'peripheral']),
  net('headset', 'Headset / support', 'headset_mic', ['headset', 'support', 'call centre', 'call center', 'helpdesk'])
]
