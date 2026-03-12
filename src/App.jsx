import React, { useState, useMemo, useCallback, useEffect } from 'react';
import {
  ShoppingCart, Package, MapPin, MessageSquare, BarChart3, Search,
  Check, AlertTriangle, ExternalLink, ChevronDown, ChevronRight, X,
  Send, Plus, Settings, Home, FileText, Truck, Edit3, Save, Trash2,
  Filter, RefreshCw, AlertCircle, CheckCircle, XCircle, Eye, ArrowUpDown,
  Zap
} from 'lucide-react';
import { MIC_DATA } from './data/micData';
import { SITES_DATA } from './data/sitesData';

const MOCK_ORDERS = [
  {
    id: 'ORD-2024-001',
    siteId: 'PAL1',
    siteName: 'Palo Alto',
    date: '2024-12-15',
    status: 'Delivered',
    domain: 'SUPPLIES',
    itemCount: 24,
    total: 1250.50,
    items: []
  },
  {
    id: 'ORD-2024-002',
    siteId: 'PIE1',
    siteName: 'Piedmont',
    date: '2024-12-10',
    status: 'Shipped',
    domain: 'FFE',
    itemCount: 8,
    total: 3240.00,
    items: []
  },
  {
    id: 'ORD-2024-003',
    siteId: 'ROS-001',
    siteName: 'Roswell',
    date: '2024-12-01',
    status: 'Approved',
    domain: 'All',
    itemCount: 42,
    total: 5890.75,
    items: []
  },
  {
    id: 'ORD-2024-004',
    siteId: 'PAL1',
    siteName: 'Palo Alto',
    date: '2024-11-20',
    status: 'Delivered',
    domain: 'SUPPLIES',
    itemCount: 35,
    total: 2150.25,
    items: []
  }
];

const parseASIN = (link) => {
  if (!link || !link.includes('amazon.com')) return null;
  const match = link.match(/\/dp\/([A-Z0-9]{10})|\/gp\/product\/([A-Z0-9]{10})/);
  return match ? (match[1] || match[2]) : null;
};

const buildAmazonCartURLs = (items, maxPerBatch = 40) => {
  const amazonItems = items
    .filter(item => parseASIN(item.LINK) !== null)
    .map(item => ({
      asin: parseASIN(item.LINK),
      quantity: item.quantity || 1,
      name: item.ITEM_NAME,
      price: item.UNIT_PRICE || 0,
      link: item.LINK,
    }));

  const nonAmazonItems = items.filter(item => !parseASIN(item.LINK));

  const batches = [];
  for (let i = 0; i < amazonItems.length; i += maxPerBatch) {
    const batch = amazonItems.slice(i, i + maxPerBatch);
    const formFields = {};
    batch.forEach((item, idx) => {
      formFields[`ASIN.${idx + 1}`] = item.asin;
      formFields[`Quantity.${idx + 1}`] = String(item.quantity);
    });
    batches.push({
      formFields,
      items: batch,
      itemCount: batch.length,
      estimatedTotal: batch.reduce((sum, i) => sum + (i.price * i.quantity), 0),
    });
  }

  return {
    batches,
    totalAmazonItems: amazonItems.length,
    nonAmazonItems,
    totalBatches: batches.length,
  };
};

const submitAmazonCart = (formFields) => {
  const form = document.createElement('form');
  form.method = 'GET';
  form.action = 'https://www.amazon.com/gp/aws/cart/add.html';
  form.target = '_blank';
  Object.entries(formFields).forEach(([key, value]) => {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = key;
    input.value = value;
    form.appendChild(input);
  });
  document.body.appendChild(form);
  form.submit();
  document.body.removeChild(form);
};

export default function JasonApp() {
  const [currentPage, setCurrentPage] = useState('dashboard');
  const [selectedSite, setSelectedSite] = useState('PAL1');
  const [selectedDomain, setSelectedDomain] = useState('All');
  const [cartItems, setCartItems] = useState([]);
  const [micItems, setMicItems] = useState(MIC_DATA);
  const [orders, setOrders] = useState(MOCK_ORDERS);
  const [chatMessages, setChatMessages] = useState([
    { id: 1, sender: 'jason', text: "Hi J.R.! I'm Jason, your procurement agent. Try: 'order supplies for Roswell' or 'mic health check'" }
  ]);
  const [chatInput, setChatInput] = useState('');
  const [showChat, setShowChat] = useState(false);
  const [expandedCategories, setExpandedCategories] = useState({});
  const [micSearchQuery, setMicSearchQuery] = useState('');
  const [micSortColumn, setMicSortColumn] = useState('ITEM_ID');
  const [micSortDirection, setMicSortDirection] = useState('asc');
  const [expandedMicItem, setExpandedMicItem] = useState(null);

  // ============================================================================
  // UTILITY FUNCTIONS
  // ============================================================================

  const calculateMICHealth = useCallback(() => {
    const withPrice = micItems.filter(i => i.UNIT_PRICE && i.UNIT_PRICE !== '').length;
    const withLink = micItems.filter(i => i.LINK && i.LINK !== '').length;
    const withVendor = micItems.filter(i => i.VENDOR && i.VENDOR !== '').length;
    const fullyCatalogued = micItems.filter(i =>
      (i.UNIT_PRICE && i.UNIT_PRICE !== '') &&
      (i.LINK && i.LINK !== '') &&
      (i.VENDOR && i.VENDOR !== '')
    ).length;

    const healthScore = Math.round((fullyCatalogued / micItems.length) * 100);
    return {
      healthScore,
      fullyCatalogued,
      missingPrice: micItems.length - withPrice,
      missingLink: micItems.length - withLink,
      missingVendor: micItems.length - withVendor
    };
  }, [micItems]);

  const health = useMemo(() => calculateMICHealth(), [calculateMICHealth]);

  const getItemHealth = (item) => {
    const hasPrice = item.UNIT_PRICE && item.UNIT_PRICE !== '';
    const hasLink = item.LINK && item.LINK !== '';
    const hasVendor = item.VENDOR && item.VENDOR !== '';

    if (hasPrice && hasLink && hasVendor) return 'good';
    if (hasPrice && (hasLink || hasVendor)) return 'warning';
    return 'critical';
  };

  const calculateQuantity = (item) => {
    if (item.DOMAIN !== 'SUPPLIES') return 1;

    const site = SITES_DATA.find(s => s.site_id === selectedSite);
    if (!site) return 1;

    const multiplier = 1; // TODO: Pull from BOM Multiplier field once MIC schema includes it
    const qtyType = item.SUB_KIT ? 'PER_CLASSROOM' : 'PER_SITE'; // Heuristic: items with SUB_KIT "Classroom" are PER_CLASSROOM
    const grades = item.GRADE_LEVEL ? item.GRADE_LEVEL.split(',').map(g => g.trim()) : ['All'];

    // Helper: get applicable classrooms based on grade levels
    const getClassrooms = () => {
      if (grades.includes('All')) {
        return (site.wl_classrooms || 0) + (site.ll_classrooms || 0) +
               (site.l1_classrooms || 0) + (site.l2_classrooms || 0) +
               (site.l3_classrooms || 0) + (site.l4_classrooms || 0);
      }
      let c = 0;
      if (grades.includes('WL')) c += site.wl_classrooms || 0;
      if (grades.includes('LL')) c += site.ll_classrooms || 0;
      if (grades.includes('L1')) c += site.l1_classrooms || 0;
      if (grades.includes('L2')) c += site.l2_classrooms || 0;
      if (grades.includes('L3')) c += site.l3_classrooms || 0;
      if (grades.includes('L4')) c += site.l4_classrooms || 0;
      return c;
    };

    // Helper: get applicable students
    const getStudents = () => {
      const gradeMap = {
        WL: (site.wl_classrooms || 0) * (site.wl_students || 5),
        LL: (site.ll_classrooms || 0) * (site.ll_students || 6),
        L1: (site.l1_classrooms || 0) * (site.l1_students || 6),
        L2: (site.l2_classrooms || 0) * (site.l2_students || 6),
        L3: (site.l3_classrooms || 0) * (site.l3_students || 6),
        L4: (site.l4_classrooms || 0) * (site.l4_students || 5),
      };
      if (grades.includes('All')) return Object.values(gradeMap).reduce((a, b) => a + b, 0);
      return grades.reduce((sum, g) => sum + (gradeMap[g] || 0), 0);
    };

    // Determine quantity type from SUB_KIT / category heuristic
    const subKit = (item.SUB_KIT || '').toLowerCase();
    const isPerSite = ['site infrastructure', 'operations & facilities', 'medical & health', 'communications & safety', 'staff support'].some(k => subKit.includes(k.toLowerCase())) || !item.SUB_KIT;
    const isPerStudent = subKit === 'per_student'; // Rarely used in current data

    if (isPerStudent) return Math.max(1, Math.ceil(getStudents() * multiplier));
    if (isPerSite) return Math.max(1, multiplier);
    // Default: PER_CLASSROOM for Classroom sub-kit items
    return Math.max(1, getClassrooms() * multiplier);
  };

  // ============================================================================
  // CHAT HANDLER
  // ============================================================================

  const [chatLoading, setChatLoading] = useState(false);
  const [chatHistory, setChatHistory] = useState([]);

  const buildMICSummary = useCallback(() => {
    const domains = {};
    micItems.forEach(item => {
      if (!domains[item.DOMAIN]) domains[item.DOMAIN] = { total: 0, withPrice: 0, withLink: 0, withVendor: 0, categories: {} };
      domains[item.DOMAIN].total++;
      if (item.UNIT_PRICE && item.UNIT_PRICE !== '') domains[item.DOMAIN].withPrice++;
      if (item.LINK && item.LINK !== '') domains[item.DOMAIN].withLink++;
      if (item.VENDOR && item.VENDOR !== '') domains[item.DOMAIN].withVendor++;
      if (!domains[item.DOMAIN].categories[item.CATEGORY]) domains[item.DOMAIN].categories[item.CATEGORY] = 0;
      domains[item.DOMAIN].categories[item.CATEGORY]++;
    });
    let summary = `Total items: ${micItems.length}\n`;
    Object.entries(domains).forEach(([domain, data]) => {
      summary += `\n${domain}: ${data.total} items (${data.withPrice} with price, ${data.withLink} with link, ${data.withVendor} with vendor)\n`;
      summary += `Categories: ${Object.entries(data.categories).map(([c, n]) => `${c} (${n})`).join(', ')}\n`;
    });
    summary += `\nHealth: ${health.fullyCatalogued} fully catalogued, ${health.missingPrice} missing price, ${health.missingLink} missing link, ${health.missingVendor} missing vendor`;
    return summary;
  }, [micItems, health]);

  const buildSitesSummary = useCallback(() => {
    return SITES_DATA.map(s =>
      `${s.site_name} (${s.site_id}): ${s.shipping_address}, Classrooms: WL=${s.wl_classrooms||0}, LL=${s.ll_classrooms||0}, L1=${s.l1_classrooms||0}, L2=${s.l2_classrooms||0}, Students/class: WL=${s.wl_students||0}, LL=${s.ll_students||0}, L1=${s.l1_students||0}, L2=${s.l2_students||0}`
    ).join('\n');
  }, []);

  const executeActions = useCallback((actions) => {
    actions.forEach(action => {
      switch (action.type) {
        case 'navigate':
          if (['dashboard', 'order-builder', 'mic', 'sites', 'orders'].includes(action.value)) {
            setCurrentPage(action.value);
          }
          break;
        case 'select-site':
          if (SITES_DATA.find(s => s.site_id === action.value)) {
            setSelectedSite(action.value);
          }
          break;
        case 'select-domain':
          if (['All', 'SUPPLIES', 'FFE', 'CONSTRUCTION'].includes(action.value)) {
            setSelectedDomain(action.value);
          }
          break;
        case 'select-all':
          // Handled by dispatching to Order Builder
          break;
        case 'clear-cart':
          setCartItems([]);
          break;
      }
    });
  }, []);

  const handleChatSubmit = async () => {
    if (!chatInput.trim() || chatLoading) return;

    const userText = chatInput;
    const newUserMessage = { id: chatMessages.length + 1, sender: 'user', text: userText };
    setChatInput('');
    setChatMessages(prev => [...prev, newUserMessage]);
    setChatLoading(true);

    // Build conversation history for Claude
    const newHistory = [...chatHistory, { role: 'user', content: userText }];

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: newHistory,
          micSummary: buildMICSummary(),
          sitesData: buildSitesSummary(),
          currentCart: cartItems,
          currentPage: currentPage,
        }),
      });

      if (!response.ok) throw new Error(`API error: ${response.status}`);

      const data = await response.json();

      // Strip action tags from displayed message
      const cleanMessage = data.message.replace(/\[ACTION:[\w-]*:?[\w-]*\]/g, '').trim();

      setChatMessages(prev => [...prev, { id: prev.length + 1, sender: 'jason', text: cleanMessage }]);
      setChatHistory([...newHistory, { role: 'assistant', content: data.message }]);

      // Execute any actions Claude requested
      if (data.actions && data.actions.length > 0) {
        executeActions(data.actions);
      }
    } catch (error) {
      console.error('Chat error:', error);
      setChatMessages(prev => [...prev, {
        id: prev.length + 1,
        sender: 'jason',
        text: `Connection issue — falling back to local mode. Try: "order supplies for Roswell", "mic health check", or "cost for Palo Alto".`
      }]);
    } finally {
      setChatLoading(false);
    }
  };

  // ============================================================================
  // DASHBOARD PAGE
  // ============================================================================

  const DashboardPage = () => {
    const totalItems = MIC_DATA.length;
    const pendingOrders = orders.filter(o => o.status === 'Pending Review').length;

    return (
      <div className="space-y-6">
        <div className="grid grid-cols-4 gap-4">
          <div className="bg-white p-6 rounded-lg shadow-md border-l-4 border-blue-500">
            <div className="text-sm text-gray-600">Total MIC Items</div>
            <div className="text-3xl font-bold text-gray-900">{totalItems}</div>
          </div>
          <div className="bg-white p-6 rounded-lg shadow-md border-l-4 border-green-500">
            <div className="text-sm text-gray-600">Active Sites</div>
            <div className="text-3xl font-bold text-gray-900">{SITES_DATA.length}</div>
          </div>
          <div className="bg-white p-6 rounded-lg shadow-md border-l-4 border-orange-500">
            <div className="text-sm text-gray-600">Pending Orders</div>
            <div className="text-3xl font-bold text-gray-900">{pendingOrders}</div>
          </div>
          <div className="bg-white p-6 rounded-lg shadow-md border-l-4 border-purple-500">
            <div className="text-sm text-gray-600">MIC Health Score</div>
            <div className="text-3xl font-bold text-gray-900">{health.healthScore}%</div>
          </div>
        </div>

        {health.healthScore < 80 && (
          <div className="bg-yellow-50 border-l-4 border-yellow-400 p-4 rounded">
            <div className="flex items-start">
              <AlertTriangle className="text-yellow-600 mr-3 flex-shrink-0" size={20} />
              <div>
                <h3 className="font-semibold text-yellow-900">MIC Health Alert</h3>
                <p className="text-yellow-700 text-sm mt-1">
                  {health.missingPrice + health.missingLink + health.missingVendor} items need attention — missing prices, links, or vendors
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="bg-white p-6 rounded-lg shadow-md">
          <h3 className="font-semibold text-gray-900 mb-4">Quick Actions</h3>
          <div className="flex flex-wrap gap-3">
            <button
              onClick={() => setCurrentPage('order-builder')}
              className="flex items-center bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg transition"
            >
              <ShoppingCart size={18} className="mr-2" />
              New School Order
            </button>
            <button
              onClick={() => setCurrentPage('mic')}
              className="flex items-center bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg transition"
            >
              <RefreshCw size={18} className="mr-2" />
              Run MIC Health Check
            </button>
            <button
              onClick={() => setCurrentPage('orders')}
              className="flex items-center bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-lg transition"
            >
              <BarChart3 size={18} className="mr-2" />
              View Orders
            </button>
          </div>
        </div>

        <div className="bg-white p-6 rounded-lg shadow-md">
          <h3 className="font-semibold text-gray-900 mb-4">Recent Activity</h3>
          <div className="space-y-3">
            {orders.slice(-4).map(order => (
              <div key={order.id} className="flex items-center justify-between pb-3 border-b last:border-b-0">
                <div>
                  <p className="font-medium text-gray-900">{order.id}</p>
                  <p className="text-sm text-gray-600">{order.siteName} • {order.itemCount} items</p>
                </div>
                <div className="text-right">
                  <p className="font-semibold text-gray-900">${order.total.toFixed(2)}</p>
                  <p className={`text-xs font-medium ${order.status === 'Delivered' ? 'text-green-600' : order.status === 'Shipped' ? 'text-blue-600' : 'text-yellow-600'}`}>
                    {order.status}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  // ============================================================================
  // ORDER BUILDER PAGE - CORE FEATURE
  // ============================================================================

  const OrderBuilderPage = () => {
    const filteredItems = useMemo(() => {
      let items = MIC_DATA;
      if (selectedDomain !== 'All') {
        items = items.filter(i => i.DOMAIN === selectedDomain);
      }
      return items;
    }, [selectedDomain]);

    const groupedByCategory = useMemo(() => {
      const groups = {};
      filteredItems.forEach(item => {
        if (!groups[item.CATEGORY]) groups[item.CATEGORY] = [];
        groups[item.CATEGORY].push(item);
      });
      return groups;
    }, [filteredItems]);

    const cartTotal = useMemo(() => {
      return cartItems.reduce((sum, item) => {
        const price = parseFloat(item.UNIT_PRICE) || 0;
        return sum + (price * item.quantity);
      }, 0);
    }, [cartItems]);

    const toggleCategory = (category) => {
      setExpandedCategories(prev => ({
        ...prev,
        [category]: !prev[category]
      }));
    };

    const addToCart = (item) => {
      const existing = cartItems.find(ci => ci.ITEM_ID === item.ITEM_ID);
      const qty = calculateQuantity(item);
      if (existing) {
        return; // Already in cart, don't double-add
      } else {
        setCartItems(prev => [...prev, { ...item, quantity: qty }]);
      }
    };

    const removeFromCart = (itemId) => {
      setCartItems(prev => prev.filter(ci => ci.ITEM_ID !== itemId));
    };

    const updateCartQuantity = (itemId, newQty) => {
      const qty = Math.max(1, parseInt(newQty) || 1);
      setCartItems(prev => prev.map(ci =>
        ci.ITEM_ID === itemId ? { ...ci, quantity: qty } : ci
      ));
    };

    const isCategoryFullySelected = (category) => {
      const items = groupedByCategory[category] || [];
      return items.length > 0 && items.every(item => cartItems.find(ci => ci.ITEM_ID === item.ITEM_ID));
    };

    const isCategoryPartiallySelected = (category) => {
      const items = groupedByCategory[category] || [];
      const selectedCount = items.filter(item => cartItems.find(ci => ci.ITEM_ID === item.ITEM_ID)).length;
      return selectedCount > 0 && selectedCount < items.length;
    };

    const toggleSelectAllCategory = (category) => {
      const items = groupedByCategory[category] || [];
      if (isCategoryFullySelected(category)) {
        // Deselect all in this category
        const idsToRemove = new Set(items.map(i => i.ITEM_ID));
        setCartItems(prev => prev.filter(ci => !idsToRemove.has(ci.ITEM_ID)));
      } else {
        // Select all in this category (add only those not already in cart)
        const existingIds = new Set(cartItems.map(ci => ci.ITEM_ID));
        const newItems = items
          .filter(item => !existingIds.has(item.ITEM_ID))
          .map(item => ({ ...item, quantity: calculateQuantity(item) }));
        setCartItems(prev => [...prev, ...newItems]);
      }
    };

    // Amazon cart URL generation for current cart
    const amazonCart = useMemo(() => {
      if (cartItems.length === 0) return null;
      return buildAmazonCartURLs(cartItems);
    }, [cartItems]);

    const [showOrderModal, setShowOrderModal] = useState(false);

    // ---- Agent / Magic Mode ordering state ----
    const LOCAL_AGENT_URL = 'http://localhost:3001';
    const RAILWAY_API_URL = (() => {
      const raw = typeof import.meta !== 'undefined' && import.meta.env?.VITE_RAILWAY_API_URL;
      return raw ? raw.replace(/\/+$/, '') : null;
    })();

    const [agentStatus, setAgentStatus] = useState(null);
    const [agentScreenshot, setAgentScreenshot] = useState(null);
    const [agentSessionId, setAgentSessionId] = useState(null);
    const [agentError, setAgentError] = useState(null);
    const [agentFailedItems, setAgentFailedItems] = useState([]);
    const [agentItems, setAgentItems] = useState([]); // items sent to agent (for 2FA continue)
    const [showAgentModal, setShowAgentModal] = useState(false);
    const [agentMode, setAgentMode] = useState(null); // 'local' | 'magic'
    const [magicAvailable, setMagicAvailable] = useState(null); // null=unchecked, true, false
    const [twoFACode, setTwoFACode] = useState('');

    // Check if Railway server is reachable on mount
    useEffect(() => {
      if (!RAILWAY_API_URL) {
        console.warn('[Magic Mode] VITE_RAILWAY_API_URL not set — Magic Mode disabled');
        setMagicAvailable(false);
        return;
      }
      console.log('[Magic Mode] Checking Railway server:', RAILWAY_API_URL);
      fetch(`${RAILWAY_API_URL}/api/config`)
        .then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then(d => {
          console.log('[Magic Mode] Server response:', d);
          setMagicAvailable(d.ready === true);
          if (!d.ready) console.warn('[Magic Mode] Server reachable but ready=false (AMAZON_EMAIL/PASSWORD not set on Railway)');
        })
        .catch(err => {
          console.error('[Magic Mode] Failed to reach Railway server:', err.message);
          setMagicAvailable(false);
        });
    }, []);

    const resetAgentState = () => {
      setAgentStatus(null);
      setAgentScreenshot(null);
      setAgentSessionId(null);
      setAgentError(null);
      setAgentFailedItems([]);
      setAgentItems([]);
      setTwoFACode('');
    };

    const getAgentUrl = () => agentMode === 'magic' ? RAILWAY_API_URL : LOCAL_AGENT_URL;

    // SSE helper: reads event-stream from agent server
    const streamAgentSSE = async (url, body) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === 'status') {
                setAgentStatus({ phase: data.phase, message: data.message });
              } else if (data.type === 'result') {
                return data;
              }
            } catch (_) {}
          }
        }
      }
      return null;
    };

    // Build the capped items list from cart
    const buildAgentItems = () => {
      const amazonItems = cartItems
        .filter(item => parseASIN(item.LINK))
        .map(item => ({
          asin: parseASIN(item.LINK),
          quantity: item.quantity || 1,
          name: item.ITEM_NAME,
          price: parseFloat(item.UNIT_PRICE) || 0,
        }));

      const itemsToSend = [];
      let totalQty = 0;
      for (const item of amazonItems) {
        if (totalQty + item.quantity >= 100) break;
        itemsToSend.push(item);
        totalQty += item.quantity;
      }

      return { amazonItems, itemsToSend, totalQty, skippedCount: amazonItems.length - itemsToSend.length };
    };

    const startAgentOrder = async (mode) => {
      resetAgentState();
      setAgentMode(mode);
      setShowAgentModal(true);

      const baseUrl = mode === 'magic' ? RAILWAY_API_URL : LOCAL_AGENT_URL;
      const { amazonItems, itemsToSend, totalQty, skippedCount } = buildAgentItems();

      if (amazonItems.length === 0) {
        setAgentError('No Amazon items with valid ASINs in cart.');
        return;
      }
      if (itemsToSend.length === 0) {
        setAgentError('First item quantity is >= 100. Reduce quantities to use agent ordering.');
        return;
      }

      setAgentItems(itemsToSend);
      const skippedMsg = skippedCount > 0 ? ` (${skippedCount} items deferred — qty limit)` : '';
      const modeLabel = mode === 'magic' ? 'Magic Mode' : 'Local Agent';
      setAgentStatus({ phase: 'starting', message: `${modeLabel}: starting for ${itemsToSend.length} items (${totalQty} total qty)${skippedMsg}...` });

      try {
        const result = await streamAgentSSE(`${baseUrl}/api/amazon-order`, { items: itemsToSend });

        if (!result) {
          setAgentError('Lost connection to agent server.');
          return;
        }

        setAgentSessionId(result.sessionId);
        if (result.screenshot) setAgentScreenshot(result.screenshot);

        if (result.status === 'awaiting-approval') {
          if (result.itemsFailed?.length > 0) setAgentFailedItems(result.itemsFailed);
          setAgentStatus({ phase: 'awaiting-approval', message: result.itemsAdded != null ? `At checkout — ${result.itemsAdded} items in cart. Review and confirm.` : 'At checkout. Review the screenshot and confirm.' });
        } else if (result.status === 'needs-intervention') {
          setAgentStatus({
            phase: result.reason,
            message: result.reason === '2fa'
              ? (mode === 'magic' ? 'Verification code required. Check your email and enter the code below.' : 'Verification required — complete it in the browser window, then click resume.')
              : 'CAPTCHA detected — check the screenshot.',
          });
        } else if (result.status === 'error') {
          setAgentError(result.reason);
        }
      } catch (err) {
        const hint = mode === 'magic' ? 'Is the Railway server running?' : 'Is the local server running? (node server/index.js)';
        setAgentError(`Could not connect to agent server. ${hint}`);
      }
    };

    // Submit 2FA code remotely (Magic Mode)
    const handleSubmit2FA = async () => {
      if (!agentSessionId || !twoFACode.trim()) return;
      const baseUrl = getAgentUrl();

      setAgentStatus({ phase: '2fa-submitting', message: 'Submitting verification code...' });
      setAgentError(null);

      try {
        const result = await streamAgentSSE(`${baseUrl}/api/amazon-order/2fa`, {
          sessionId: agentSessionId,
          code: twoFACode.trim(),
        });

        if (result?.screenshot) setAgentScreenshot(result.screenshot);
        setTwoFACode('');

        if (result?.status === '2fa-resolved') {
          // 2FA passed — now continue with items
          setAgentStatus({ phase: 'continuing', message: 'Verified! Now adding items to cart...' });
          const contResult = await streamAgentSSE(`${baseUrl}/api/amazon-order/continue`, {
            sessionId: agentSessionId,
            items: agentItems,
          });

          if (contResult?.screenshot) setAgentScreenshot(contResult.screenshot);

          if (contResult?.status === 'awaiting-approval') {
            if (contResult.itemsFailed?.length > 0) setAgentFailedItems(contResult.itemsFailed);
            setAgentStatus({ phase: 'awaiting-approval', message: contResult.itemsAdded != null ? `At checkout — ${contResult.itemsAdded} items in cart. Review and confirm.` : 'At checkout. Review and confirm.' });
          } else if (contResult?.status === 'error') {
            setAgentError(contResult.reason);
          }
        } else if (result?.status === 'needs-intervention') {
          setAgentStatus({ phase: '2fa', message: 'Code may be incorrect. Check your email and try again.' });
        } else if (result?.status === 'error') {
          setAgentError(result.reason);
        }
      } catch (err) {
        setAgentError(`Connection error: ${err.message}`);
      }
    };

    // Resume after local browser intervention
    const handleAgentResume = async () => {
      if (!agentSessionId) return;
      const baseUrl = getAgentUrl();
      setAgentStatus({ phase: 'resuming', message: 'Checking browser state...' });

      try {
        const result = await streamAgentSSE(`${baseUrl}/api/amazon-order/resume`, { sessionId: agentSessionId });
        if (result?.screenshot) setAgentScreenshot(result.screenshot);

        if (result?.status === 'intervention-resolved') {
          setAgentStatus({ phase: 'signed-in', message: 'Verified! You can now re-run the order.' });
        } else if (result?.status === 'needs-intervention') {
          setAgentStatus({ phase: '2fa', message: 'Still on verification page. Complete it in the browser, then try again.' });
        }
      } catch (err) {
        setAgentError(`Connection error: ${err.message}`);
      }
    };

    const handleAgentConfirmPurchase = async () => {
      if (!agentSessionId) return;
      const baseUrl = getAgentUrl();
      setAgentStatus({ phase: 'placing-order', message: 'Placing order...' });

      try {
        const result = await streamAgentSSE(`${baseUrl}/api/amazon-order/confirm`, { sessionId: agentSessionId });
        if (result?.screenshot) setAgentScreenshot(result.screenshot);

        if (result?.status === 'order-placed') {
          setAgentStatus({ phase: 'order-placed', message: 'Order placed successfully!' });
        } else if (result?.status === 'error') {
          setAgentError(result.reason);
        }
      } catch (err) {
        setAgentError(`Connection error: ${err.message}`);
      }
    };

    const handleAgentClose = async () => {
      if (agentSessionId) {
        try {
          const baseUrl = getAgentUrl();
          await fetch(`${baseUrl}/api/amazon-order/${agentSessionId}`, { method: 'DELETE' });
        } catch (_) {}
      }
      resetAgentState();
      setShowAgentModal(false);
      setAgentMode(null);
    };

    const handleApproveOrder = () => {
      if (cartItems.length === 0) return;
      setShowOrderModal(true);
    };

    const confirmOrder = () => {
      const newOrder = {
        id: `ORD-${new Date().getFullYear()}-${String(orders.length + 1).padStart(3, '0')}`,
        siteId: selectedSite,
        siteName: SITES_DATA.find(s => s.site_id === selectedSite)?.site_name || '',
        date: new Date().toISOString().split('T')[0],
        status: 'Approved',
        domain: selectedDomain,
        itemCount: cartItems.length,
        total: cartTotal,
        items: cartItems,
        amazonBatches: amazonCart?.batches || [],
      };
      setOrders([...orders, newOrder]);
      setCartItems([]);
      setShowOrderModal(false);
      setCurrentPage('orders');
    };

    return (
      <div className="grid grid-cols-3 gap-6">
        <div className="col-span-2 space-y-6">
          <div className="bg-white p-6 rounded-lg shadow-md">
            <h3 className="font-semibold text-gray-900 mb-4">Step 1: Select Site & Domain</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">School Site</label>
                <select
                  value={selectedSite}
                  onChange={(e) => setSelectedSite(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {SITES_DATA.map(site => (
                    <option key={site.site_id} value={site.site_id}>
                      {site.site_name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Domain</label>
                <select
                  value={selectedDomain}
                  onChange={(e) => setSelectedDomain(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="All">All Domains</option>
                  <option value="SUPPLIES">Supplies Only</option>
                  <option value="FFE">FFE Only</option>
                  <option value="CONSTRUCTION">Construction Only</option>
                </select>
              </div>
            </div>
          </div>

          <div className="bg-white p-6 rounded-lg shadow-md">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-gray-900">Step 2: Select Items ({filteredItems.length} available)</h3>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    const existingIds = new Set(cartItems.map(ci => ci.ITEM_ID));
                    const newItems = filteredItems
                      .filter(item => !existingIds.has(item.ITEM_ID))
                      .map(item => ({ ...item, quantity: calculateQuantity(item) }));
                    setCartItems(prev => [...prev, ...newItems]);
                  }}
                  className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition font-medium"
                >
                  Select All ({filteredItems.length})
                </button>
                {cartItems.length > 0 && (
                  <button
                    onClick={() => setCartItems([])}
                    className="px-3 py-1.5 text-xs bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition font-medium"
                  >
                    Clear Cart
                  </button>
                )}
              </div>
            </div>
            <div className="space-y-3 max-h-96 overflow-y-auto">
              {Object.entries(groupedByCategory).map(([category, items]) => {
                const allSelected = isCategoryFullySelected(category);
                const partialSelected = isCategoryPartiallySelected(category);
                const selectedCount = items.filter(item => cartItems.find(ci => ci.ITEM_ID === item.ITEM_ID)).length;
                return (
                <div key={category} className="border rounded-lg overflow-hidden">
                  <div className="flex items-center bg-gray-50 hover:bg-gray-100 transition">
                    <div className="pl-4 flex items-center" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={allSelected}
                        ref={el => { if (el) el.indeterminate = partialSelected; }}
                        onChange={() => toggleSelectAllCategory(category)}
                        className="cursor-pointer w-4 h-4"
                        title={allSelected ? `Deselect all ${items.length} items` : `Select all ${items.length} items`}
                      />
                    </div>
                    <button
                      onClick={() => toggleCategory(category)}
                      className="flex-1 flex items-center justify-between p-4 font-medium"
                    >
                      <span className="text-gray-900">{category}</span>
                      <div className="flex items-center gap-2">
                        {selectedCount > 0 && (
                          <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">{selectedCount}/{items.length} selected</span>
                        )}
                        <span className="text-sm text-gray-500">{items.length} items</span>
                        {expandedCategories[category] ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                      </div>
                    </button>
                  </div>

                  {expandedCategories[category] && (
                    <div className="border-t p-4 space-y-2">
                      {items.map(item => {
                        const inCart = cartItems.find(ci => ci.ITEM_ID === item.ITEM_ID);
                        const price = parseFloat(item.UNIT_PRICE) || 0;

                        return (
                          <div key={item.ITEM_ID} className="bg-gray-50 p-3 rounded flex items-start gap-3">
                            <input
                              type="checkbox"
                              checked={!!inCart}
                              onChange={() => inCart ? removeFromCart(item.ITEM_ID) : addToCart(item)}
                              className="mt-1 cursor-pointer"
                            />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-medium text-gray-900">{item.ITEM_NAME}</span>
                                <span className="text-xs text-gray-500">({item.ITEM_ID})</span>
                                {!price && (
                                  <span className="px-2 py-1 bg-yellow-100 text-yellow-800 text-xs rounded whitespace-nowrap">Price needed</span>
                                )}
                                {!item.LINK && (
                                  <span className="px-2 py-1 bg-red-100 text-red-800 text-xs rounded whitespace-nowrap">No link</span>
                                )}
                              </div>
                              <p className="text-sm text-gray-600 mt-1">{item.VENDOR || 'Unknown Vendor'}</p>
                            </div>
                            <div className="text-right flex-shrink-0">
                              <p className="font-semibold text-gray-900">${price.toFixed(2)}</p>
                              {inCart && (
                                <div className="flex items-center gap-1 mt-1 justify-end">
                                  <label className="text-xs text-gray-500">Qty:</label>
                                  <input
                                    type="number"
                                    min="1"
                                    value={inCart.quantity}
                                    onChange={(e) => updateCartQuantity(item.ITEM_ID, e.target.value)}
                                    className="w-14 px-1 py-0.5 text-sm text-center border border-blue-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                                  />
                                </div>
                              )}
                            </div>
                            {item.LINK && (
                              <a href={item.LINK} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 flex-shrink-0">
                                <ExternalLink size={16} />
                              </a>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
              })}
            </div>
          </div>
        </div>

        <div>
          <div className="bg-white p-6 rounded-lg shadow-md sticky top-6">
            <h3 className="font-semibold text-gray-900 mb-4">Cart Summary</h3>

            <div className="space-y-3 mb-4 pb-4 border-b">
              <div className="flex justify-between">
                <span className="text-gray-600">Items in cart:</span>
                <span className="font-semibold text-gray-900">{cartItems.length}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Total Cost:</span>
                <span className="font-bold text-lg text-blue-600">${cartTotal.toFixed(2)}</span>
              </div>
            </div>

            {cartItems.length > 0 && (
              <div className="space-y-2 mb-4 max-h-48 overflow-y-auto">
                <p className="text-xs font-semibold text-gray-700 mb-2">Items ({cartItems.length}):</p>
                {cartItems.map(item => (
                  <div key={item.ITEM_ID} className="text-xs bg-gray-50 p-2 rounded flex items-center gap-1">
                    <span className="text-gray-700 flex-1 pr-1 truncate" title={item.ITEM_NAME}>{item.ITEM_NAME}</span>
                    <input
                      type="number"
                      min="1"
                      value={item.quantity}
                      onChange={(e) => updateCartQuantity(item.ITEM_ID, e.target.value)}
                      className="w-12 px-1 py-0.5 text-xs text-center border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500 flex-shrink-0"
                    />
                    <button
                      onClick={() => removeFromCart(item.ITEM_ID)}
                      className="text-red-600 hover:text-red-800 flex-shrink-0"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Amazon Cart Info */}
            {amazonCart && amazonCart.totalAmazonItems > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-3">
                <div className="flex items-center gap-2 mb-1">
                  <ShoppingCart size={16} className="text-amber-700" />
                  <span className="font-semibold text-amber-800 text-sm">Amazon Cart Ready</span>
                </div>
                <p className="text-xs text-amber-700">
                  {amazonCart.totalAmazonItems} items with valid ASINs across {amazonCart.totalBatches} cart link{amazonCart.totalBatches > 1 ? 's' : ''}.
                  {amazonCart.nonAmazonItems.length > 0 && ` ${amazonCart.nonAmazonItems.length} non-Amazon items need manual ordering.`}
                </p>
              </div>
            )}

            <button
              onClick={handleApproveOrder}
              disabled={cartItems.length === 0}
              className="w-full bg-green-600 hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-lg transition text-lg"
            >
              Review & Approve Order
            </button>
          </div>
        </div>

        {/* ORDER APPROVAL MODAL */}
        {showOrderModal && amazonCart && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[85vh] overflow-y-auto">
              <div className="p-6 border-b border-gray-200">
                <div className="flex items-center justify-between">
                  <h3 className="text-xl font-bold text-gray-900">Order Review</h3>
                  <button onClick={() => setShowOrderModal(false)} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
                </div>
                <p className="text-sm text-gray-500 mt-1">
                  {SITES_DATA.find(s => s.site_id === selectedSite)?.site_name} &mdash; {cartItems.length} items &mdash; ${cartTotal.toFixed(2)}
                </p>
              </div>

              <div className="p-6 space-y-4">
                {/* Amazon Cart Links */}
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <h4 className="font-semibold text-blue-900 flex items-center gap-2 mb-3">
                    <ShoppingCart size={18} /> Amazon Cart Links ({amazonCart.totalAmazonItems} items)
                  </h4>
                  <p className="text-sm text-blue-700 mb-3">
                    Click to add items to your Amazon cart. A new tab will open on Amazon with the items loaded.
                  </p>
                  <div className="space-y-2">
                    {amazonCart.batches.map((batch, idx) => (
                      <button
                        key={idx}
                        onClick={() => submitAmazonCart(batch.formFields)}
                        className="w-full flex items-center justify-between bg-white border border-blue-300 rounded-lg px-4 py-3 hover:bg-blue-100 transition group cursor-pointer"
                      >
                        <div className="text-left">
                          <span className="font-semibold text-blue-800 group-hover:underline">
                            {amazonCart.totalBatches > 1 ? `Add to Amazon Cart (Batch ${idx + 1} of ${amazonCart.totalBatches})` : 'Add All to Amazon Cart'}
                          </span>
                          <span className="text-sm text-gray-500 ml-2">
                            {batch.itemCount} items &mdash; est. ${batch.estimatedTotal.toFixed(2)}
                          </span>
                        </div>
                        <ExternalLink size={16} className="text-blue-600" />
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-blue-600 mt-2">
                    Tip: If items don't appear in your Amazon cart, try the individual product links below as a fallback.
                  </p>
                  <details className="mt-2">
                    <summary className="text-xs text-blue-600 cursor-pointer hover:underline">Show individual product links</summary>
                    <div className="mt-2 max-h-40 overflow-y-auto space-y-1">
                      {amazonCart.batches.flatMap(b => b.items).map((item, idx) => (
                        <a key={idx} href={item.link} target="_blank" rel="noopener noreferrer"
                          className="flex items-center justify-between text-xs py-1 px-2 hover:bg-blue-50 rounded">
                          <span className="text-gray-700 truncate flex-1">{item.name} (x{item.quantity})</span>
                          <ExternalLink size={10} className="text-blue-500 flex-shrink-0 ml-2" />
                        </a>
                      ))}
                    </div>
                  </details>
                </div>

                {/* Non-Amazon Items */}
                {amazonCart.nonAmazonItems.length > 0 && (
                  <div className="bg-orange-50 border border-orange-200 rounded-lg p-4">
                    <h4 className="font-semibold text-orange-900 flex items-center gap-2 mb-2">
                      <AlertTriangle size={18} /> Non-Amazon Items ({amazonCart.nonAmazonItems.length})
                    </h4>
                    <p className="text-sm text-orange-700 mb-2">These items need manual ordering from their respective vendors:</p>
                    <div className="space-y-1">
                      {amazonCart.nonAmazonItems.map((item, idx) => (
                        <div key={idx} className="flex items-center justify-between text-sm py-1">
                          <span className="text-gray-700">{item.ITEM_NAME}</span>
                          <div className="flex items-center gap-2">
                            <span className="text-gray-500">{item.VENDOR || 'No vendor'}</span>
                            {item.LINK && (
                              <a href={item.LINK} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800">
                                <ExternalLink size={12} />
                              </a>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Order Summary */}
                <div className="bg-gray-50 rounded-lg p-4">
                  <h4 className="font-semibold text-gray-900 mb-2">Order Summary</h4>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <span className="text-gray-600">Site:</span>
                    <span className="font-medium">{SITES_DATA.find(s => s.site_id === selectedSite)?.site_name}</span>
                    <span className="text-gray-600">Ship to:</span>
                    <span className="font-medium text-xs">{SITES_DATA.find(s => s.site_id === selectedSite)?.ship_to_address}</span>
                    <span className="text-gray-600">Total Items:</span>
                    <span className="font-medium">{cartItems.length}</span>
                    <span className="text-gray-600">Amazon Items:</span>
                    <span className="font-medium text-green-700">{amazonCart.totalAmazonItems} (auto-cart)</span>
                    <span className="text-gray-600">Manual Items:</span>
                    <span className="font-medium text-orange-700">{amazonCart.nonAmazonItems.length}</span>
                    <span className="text-gray-600">Estimated Total:</span>
                    <span className="font-bold text-lg">${cartTotal.toFixed(2)}</span>
                  </div>
                </div>
              </div>

              <div className="p-6 border-t border-gray-200 space-y-3">
                <div className="flex gap-3">
                  <button
                    onClick={() => setShowOrderModal(false)}
                    className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition"
                  >
                    Back to Cart
                  </button>
                  <button
                    onClick={confirmOrder}
                    className="flex-1 px-4 py-2 bg-green-600 hover:bg-green-700 text-white font-semibold rounded-lg transition"
                  >
                    Confirm & Save Order
                  </button>
                </div>
                {amazonCart && amazonCart.totalAmazonItems > 0 && (
                  <div className="flex gap-3">
                    <button
                      onClick={() => { setShowOrderModal(false); startAgentOrder('local'); }}
                      className="flex-1 px-4 py-3 bg-purple-600 hover:bg-purple-700 text-white font-semibold rounded-lg transition flex items-center justify-center gap-2"
                    >
                      <Package size={16} />
                      Local Agent
                    </button>
                    <button
                      onClick={() => { setShowOrderModal(false); startAgentOrder('magic'); }}
                      disabled={!magicAvailable}
                      title={!magicAvailable ? (RAILWAY_API_URL ? 'Remote server unreachable' : 'Set VITE_RAILWAY_API_URL to enable') : 'Auto-order via remote server'}
                      className={`flex-1 px-4 py-3 font-semibold rounded-lg transition flex items-center justify-center gap-2 ${
                        magicAvailable
                          ? 'bg-amber-500 hover:bg-amber-600 text-white'
                          : 'bg-gray-200 text-gray-400 cursor-not-allowed'
                      }`}
                    >
                      <Zap size={16} />
                      Magic Mode
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* AGENT / MAGIC MODE ORDERING MODAL */}
        {showAgentModal && (
          <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-[60] p-4">
            <div className="bg-white rounded-xl shadow-2xl max-w-3xl w-full max-h-[90vh] overflow-y-auto">
              <div className={`p-6 border-b ${agentMode === 'magic' ? 'border-amber-200 bg-amber-50' : 'border-gray-200'}`}>
                <div className="flex items-center justify-between">
                  <h3 className="text-xl font-bold text-gray-900 flex items-center gap-2">
                    {agentMode === 'magic' ? <Zap size={22} className="text-amber-500" /> : <Package size={22} className="text-purple-600" />}
                    {agentMode === 'magic' ? 'Magic Mode' : 'Local Agent'}
                  </h3>
                  <button onClick={handleAgentClose} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
                </div>
                <p className="text-sm text-gray-500 mt-1">
                  {agentMode === 'magic' ? 'Remote browser automation via Railway — review and approve before purchase' : 'Local browser automation — review and approve before purchase'}
                </p>
              </div>

              <div className="p-6 space-y-4">
                {/* Status Feed */}
                {agentStatus && (
                  <div className={`rounded-lg p-4 flex items-start gap-3 ${
                    agentStatus.phase === 'error' ? 'bg-red-50 border border-red-200' :
                    agentStatus.phase === 'order-placed' ? 'bg-green-50 border border-green-200' :
                    agentStatus.phase === 'awaiting-approval' ? 'bg-amber-50 border border-amber-200' :
                    agentStatus.phase === '2fa' || agentStatus.phase === 'captcha' || agentStatus.phase === '2fa-submitting' ? 'bg-orange-50 border border-orange-200' :
                    'bg-blue-50 border border-blue-200'
                  }`}>
                    <div className="flex-shrink-0 mt-0.5">
                      {agentStatus.phase === 'order-placed' ? <CheckCircle size={20} className="text-green-600" /> :
                       agentStatus.phase === 'error' ? <XCircle size={20} className="text-red-600" /> :
                       agentStatus.phase === 'awaiting-approval' ? <Eye size={20} className="text-amber-600" /> :
                       agentStatus.phase === '2fa' || agentStatus.phase === 'captcha' ? <AlertCircle size={20} className="text-orange-600" /> :
                       <RefreshCw size={20} className="text-blue-600 animate-spin" />}
                    </div>
                    <div>
                      <p className="font-semibold text-sm text-gray-900 capitalize">{agentStatus.phase.replace(/-/g, ' ')}</p>
                      <p className="text-sm text-gray-700 mt-0.5">{agentStatus.message}</p>
                    </div>
                  </div>
                )}

                {/* 2FA Code Input (Magic Mode — remote, can't access browser) */}
                {agentStatus?.phase === '2fa' && agentMode === 'magic' && (
                  <div className="bg-orange-50 border border-orange-300 rounded-lg p-4">
                    <p className="text-sm font-semibold text-orange-900 mb-2">Enter Verification Code</p>
                    <p className="text-xs text-orange-700 mb-3">Check your email for a code from Amazon and enter it below.</p>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={twoFACode}
                        onChange={(e) => setTwoFACode(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleSubmit2FA()}
                        placeholder="Enter code"
                        className="flex-1 px-3 py-2 border border-orange-300 rounded-lg text-lg tracking-widest text-center font-mono focus:outline-none focus:ring-2 focus:ring-orange-400"
                        autoFocus
                      />
                      <button
                        onClick={handleSubmit2FA}
                        disabled={!twoFACode.trim()}
                        className="px-6 py-2 bg-orange-600 hover:bg-orange-700 disabled:bg-gray-300 text-white font-semibold rounded-lg transition"
                      >
                        Submit Code
                      </button>
                    </div>
                  </div>
                )}

                {/* Error */}
                {agentError && (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                    <p className="font-semibold text-red-800 text-sm flex items-center gap-2">
                      <XCircle size={16} /> Error
                    </p>
                    <p className="text-sm text-red-700 mt-1">{agentError}</p>
                  </div>
                )}

                {/* Failed Items */}
                {agentFailedItems.length > 0 && (
                  <div className="bg-orange-50 border border-orange-200 rounded-lg p-4">
                    <h4 className="font-semibold text-orange-900 flex items-center gap-2 mb-2 text-sm">
                      <AlertTriangle size={16} /> {agentFailedItems.length} item{agentFailedItems.length > 1 ? 's' : ''} could not be added
                    </h4>
                    <div className="space-y-1 max-h-32 overflow-y-auto">
                      {agentFailedItems.map((item, idx) => (
                        <div key={idx} className="text-xs text-orange-800 flex justify-between">
                          <span className="truncate flex-1">{item.name} (x{item.quantity})</span>
                          <span className="text-orange-600 ml-2 flex-shrink-0">{item.reason}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Screenshot */}
                {agentScreenshot && (
                  <div className="border border-gray-200 rounded-lg overflow-hidden">
                    <div className="bg-gray-100 px-3 py-2 text-xs font-semibold text-gray-600 uppercase tracking-wide">
                      Browser Screenshot
                    </div>
                    <img
                      src={`data:image/png;base64,${agentScreenshot}`}
                      alt="Amazon checkout screenshot"
                      className="w-full"
                    />
                  </div>
                )}
              </div>

              {/* Action Buttons */}
              <div className="p-6 border-t border-gray-200 space-y-3">
                {agentStatus?.phase === 'awaiting-approval' && (
                  <div className="flex gap-3">
                    <button
                      onClick={handleAgentClose}
                      className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleAgentConfirmPurchase}
                      className="flex-1 px-4 py-3 bg-green-600 hover:bg-green-700 text-white font-bold rounded-lg transition text-lg"
                    >
                      Approve & Place Order
                    </button>
                  </div>
                )}
                {(agentStatus?.phase === '2fa' || agentStatus?.phase === 'captcha') && agentMode === 'local' && (
                  <button
                    onClick={handleAgentResume}
                    className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg transition"
                  >
                    I've Completed Verification — Resume
                  </button>
                )}
                {agentStatus?.phase === 'order-placed' && (
                  <button
                    onClick={() => { handleAgentClose(); confirmOrder(); }}
                    className="w-full px-4 py-3 bg-green-600 hover:bg-green-700 text-white font-bold rounded-lg transition"
                  >
                    Save Order & Close
                  </button>
                )}
                {agentStatus?.phase === 'signed-in' && (
                  <button
                    onClick={() => { handleAgentClose(); startAgentOrder(agentMode || 'local'); }}
                    className="w-full px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white font-semibold rounded-lg transition"
                  >
                    Retry Order
                  </button>
                )}
                {(agentError || (!agentStatus)) && (
                  <button
                    onClick={handleAgentClose}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition"
                  >
                    Close
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  // ============================================================================
  // MASTER ITEM CATALOGUE PAGE
  // ============================================================================

  const MICPage = () => {
    const filteredItems = useMemo(() => {
      let items = micItems;

      if (selectedDomain !== 'All') {
        items = items.filter(i => i.DOMAIN === selectedDomain);
      }

      if (micSearchQuery) {
        const query = micSearchQuery.toLowerCase();
        items = items.filter(i =>
          i.ITEM_ID.toLowerCase().includes(query) ||
          i.ITEM_NAME.toLowerCase().includes(query) ||
          i.DOMAIN.toLowerCase().includes(query) ||
          i.CATEGORY.toLowerCase().includes(query) ||
          (i.VENDOR && i.VENDOR.toLowerCase().includes(query))
        );
      }

      items.sort((a, b) => {
        let aVal = a[micSortColumn];
        let bVal = b[micSortColumn];

        if (micSortColumn === 'UNIT_PRICE') {
          aVal = parseFloat(aVal) || 0;
          bVal = parseFloat(bVal) || 0;
        }

        if (aVal < bVal) return micSortDirection === 'asc' ? -1 : 1;
        if (aVal > bVal) return micSortDirection === 'asc' ? 1 : -1;
        return 0;
      });

      return items;
    }, [micItems, selectedDomain, micSearchQuery, micSortColumn, micSortDirection]);

    const handleSort = (column) => {
      if (micSortColumn === column) {
        setMicSortDirection(micSortDirection === 'asc' ? 'desc' : 'asc');
      } else {
        setMicSortColumn(column);
        setMicSortDirection('asc');
      }
    };

    const handleCellEdit = (itemId, field, value) => {
      setMicItems(micItems.map(item =>
        item.ITEM_ID === itemId ? { ...item, [field]: value } : item
      ));
    };

    return (
      <div className="space-y-6">
        <div className="bg-white p-6 rounded-lg shadow-md">
          <h3 className="font-semibold text-gray-900 mb-3">MIC Health Summary</h3>
          <div className="grid grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-gray-600">Fully Catalogued</p>
              <p className="text-2xl font-bold text-green-600">{health.fullyCatalogued}/307</p>
            </div>
            <div>
              <p className="text-gray-600">Missing Prices</p>
              <p className="text-2xl font-bold text-yellow-600">{health.missingPrice}</p>
            </div>
            <div>
              <p className="text-gray-600">Missing Links</p>
              <p className="text-2xl font-bold text-orange-600">{health.missingLink}</p>
            </div>
            <div>
              <p className="text-gray-600">Missing Vendors</p>
              <p className="text-2xl font-bold text-red-600">{health.missingVendor}</p>
            </div>
          </div>
        </div>

        <div className="bg-white p-6 rounded-lg shadow-md">
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <input
                type="text"
                placeholder="Search items by ID, name, vendor, or category..."
                value={micSearchQuery}
                onChange={(e) => setMicSearchQuery(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
              />
            </div>
            <select
              value={selectedDomain}
              onChange={(e) => setSelectedDomain(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
            >
              <option value="All">All Domains</option>
              <option value="CONSTRUCTION">Construction</option>
              <option value="FFE">FFE</option>
              <option value="SUPPLIES">Supplies</option>
            </select>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow-md overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-100 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left">
                  <button onClick={() => handleSort('ITEM_ID')} className="flex items-center gap-1 font-semibold text-gray-900 hover:text-blue-600">
                    Item ID <ArrowUpDown size={14} className="opacity-50" />
                  </button>
                </th>
                <th className="px-4 py-3 text-left">
                  <button onClick={() => handleSort('ITEM_NAME')} className="flex items-center gap-1 font-semibold text-gray-900 hover:text-blue-600">
                    Item Name <ArrowUpDown size={14} className="opacity-50" />
                  </button>
                </th>
                <th className="px-4 py-3 text-left">
                  <button onClick={() => handleSort('DOMAIN')} className="flex items-center gap-1 font-semibold text-gray-900 hover:text-blue-600">
                    Domain <ArrowUpDown size={14} className="opacity-50" />
                  </button>
                </th>
                <th className="px-4 py-3 text-left font-semibold text-gray-900">Category</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-900">Vendor</th>
                <th className="px-4 py-3 text-right">
                  <button onClick={() => handleSort('UNIT_PRICE')} className="flex items-center justify-end gap-1 font-semibold text-gray-900 hover:text-blue-600 ml-auto">
                    Price <ArrowUpDown size={14} className="opacity-50" />
                  </button>
                </th>
                <th className="px-4 py-3 text-left font-semibold text-gray-900">Tier</th>
                <th className="px-4 py-3 text-center font-semibold text-gray-900">Health</th>
              </tr>
            </thead>
            <tbody>
              {filteredItems.map(item => {
                const itemHealth = getItemHealth(item);
                return (
                  <React.Fragment key={item.ITEM_ID}>
                    <tr
                      className="border-b hover:bg-blue-50 cursor-pointer transition"
                      onClick={() => setExpandedMicItem(expandedMicItem === item.ITEM_ID ? null : item.ITEM_ID)}
                    >
                      <td className="px-4 py-3 text-gray-900 font-medium text-sm">{item.ITEM_ID}</td>
                      <td className="px-4 py-3 text-gray-900">{item.ITEM_NAME}</td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-1 rounded text-xs font-medium ${
                          item.DOMAIN === 'SUPPLIES' ? 'bg-blue-100 text-blue-800' :
                          item.DOMAIN === 'FFE' ? 'bg-green-100 text-green-800' :
                          'bg-orange-100 text-orange-800'
                        }`}>
                          {item.DOMAIN}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-700 text-sm">{item.CATEGORY}</td>
                      <td className="px-4 py-3 text-gray-700 text-sm">{item.VENDOR || '—'}</td>
                      <td className="px-4 py-3 text-right font-semibold text-gray-900">
                        {item.UNIT_PRICE ? `$${parseFloat(item.UNIT_PRICE).toFixed(2)}` : '—'}
                      </td>
                      <td className="px-4 py-3 text-gray-700 text-sm">{item.DAY1_TIER || '—'}</td>
                      <td className="px-4 py-3 text-center">
                        {itemHealth === 'good' && <CheckCircle size={16} className="text-green-600 mx-auto" />}
                        {itemHealth === 'warning' && <AlertCircle size={16} className="text-yellow-600 mx-auto" />}
                        {itemHealth === 'critical' && <XCircle size={16} className="text-red-600 mx-auto" />}
                      </td>
                    </tr>

                    {expandedMicItem === item.ITEM_ID && (
                      <tr className="bg-blue-50 border-b">
                        <td colSpan="8" className="px-4 py-4">
                          <div className="grid grid-cols-2 gap-6 text-sm">
                            <div>
                              <p className="font-semibold text-gray-900 mb-2">Description</p>
                              <p className="text-gray-700 mb-4">{item.DESCRIPTION || '—'}</p>
                              <p className="font-semibold text-gray-900 mb-2">UOM</p>
                              <p className="text-gray-700">{item.UOM || '—'}</p>
                            </div>
                            <div>
                              <p className="font-semibold text-gray-900 mb-2">Grade Level</p>
                              <p className="text-gray-700 mb-4">{item.GRADE_LEVEL || '—'}</p>
                              <p className="font-semibold text-gray-900 mb-2">Notes</p>
                              <p className="text-gray-700">{item.NOTES || '—'}</p>
                            </div>
                          </div>

                          <div className="mt-4 pt-4 border-t">
                            <p className="font-semibold text-gray-900 mb-2 text-sm">Edit Fields</p>
                            <div className="grid grid-cols-2 gap-4 text-sm">
                              <input
                                type="text"
                                value={item.LINK}
                                onChange={(e) => handleCellEdit(item.ITEM_ID, 'LINK', e.target.value)}
                                placeholder="Product link URL..."
                                className="px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                              />
                              <input
                                type="number"
                                value={item.UNIT_PRICE}
                                onChange={(e) => handleCellEdit(item.ITEM_ID, 'UNIT_PRICE', e.target.value)}
                                placeholder="Unit price..."
                                className="px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                              />
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="text-gray-600 text-sm">Showing {filteredItems.length} of {micItems.length} items</p>
      </div>
    );
  };

  // ============================================================================
  // SITES PAGE
  // ============================================================================

  const SitesPage = () => {
    return (
      <div className="space-y-6">
        {SITES_DATA.map(site => {
          const totalClassrooms = (site.wl_classrooms || 0) + (site.ll_classrooms || 0) + (site.l1_classrooms || 0) + (site.l2_classrooms || 0);
          const totalStudents = (site.wl_students * (site.wl_classrooms || 0)) +
                               (site.ll_students * (site.ll_classrooms || 0)) +
                               (site.l1_students * (site.l1_classrooms || 0)) +
                               (site.l2_students * (site.l2_classrooms || 0));

          setSelectedSite(site.site_id);
          const suppliesCost = MIC_DATA.filter(i => i.DOMAIN === 'SUPPLIES').reduce((sum, item) => {
            const qty = calculateQuantity(item);
            const price = parseFloat(item.UNIT_PRICE) || 0;
            return sum + (qty * price);
          }, 0);

          return (
            <div key={site.site_id} className="bg-white p-6 rounded-lg shadow-md">
              <div className="flex justify-between items-start mb-4">
                <div className="flex-1">
                  <h3 className="text-lg font-semibold text-gray-900">{site.site_name}</h3>
                  <p className="text-gray-600 text-sm mt-1 flex items-center gap-2">
                    <MapPin size={16} />
                    {site.ship_to_address}
                  </p>
                  <p className="text-gray-600 text-sm mt-1">Contact: {site.ship_to_contact}</p>
                </div>
                <button
                  onClick={() => {
                    setSelectedSite(site.site_id);
                    setCurrentPage('order-builder');
                  }}
                  className="flex items-center bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg transition whitespace-nowrap"
                >
                  <ShoppingCart size={18} className="mr-2" />
                  Order Supplies
                </button>
              </div>

              <div className="grid grid-cols-3 gap-6 mb-6">
                <div>
                  <p className="text-sm font-semibold text-gray-700 mb-3">Grade Levels & Classrooms</p>
                  <div className="space-y-2 text-sm">
                    {site.wl_classrooms > 0 && <p className="text-gray-600">WL: {site.wl_classrooms} cls × {site.wl_students} std = {site.wl_classrooms * site.wl_students}</p>}
                    {site.ll_classrooms > 0 && <p className="text-gray-600">LL: {site.ll_classrooms} cls × {site.ll_students} std = {site.ll_classrooms * site.ll_students}</p>}
                    {site.l1_classrooms > 0 && <p className="text-gray-600">L1: {site.l1_classrooms} cls × {site.l1_students} std = {site.l1_classrooms * site.l1_students}</p>}
                    {site.l2_classrooms > 0 && <p className="text-gray-600">L2: {site.l2_classrooms} cls × {site.l2_students} std = {site.l2_classrooms * site.l2_students}</p>}
                    <p className="font-semibold text-gray-900 mt-2 pt-2 border-t">Total: {totalClassrooms} classrooms, {totalStudents} students</p>
                  </div>
                </div>

                <div className="bg-blue-50 p-4 rounded border border-blue-200">
                  <p className="text-sm font-semibold text-gray-700 mb-2">Estimated Supply Cost</p>
                  <p className="text-3xl font-bold text-blue-600">${suppliesCost.toFixed(2)}</p>
                  <p className="text-xs text-gray-600 mt-2">Based on classroom & student counts</p>
                </div>

                <div>
                  <p className="text-sm font-semibold text-gray-700 mb-3">Quick Stats</p>
                  <div className="space-y-2 text-sm">
                    <p className="text-gray-700"><strong>Total Classrooms:</strong> {totalClassrooms}</p>
                    <p className="text-gray-700"><strong>Total Students:</strong> {totalStudents}</p>
                    <p className="text-gray-700"><strong>Avg Class Size:</strong> {totalClassrooms > 0 ? (totalStudents / totalClassrooms).toFixed(1) : '—'}</p>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  // ============================================================================
  // ORDERS PAGE
  // ============================================================================

  const OrdersPage = () => {
    return (
      <div className="space-y-6">
        <div className="bg-white rounded-lg shadow-md overflow-hidden">
          <div className="p-6 border-b">
            <h3 className="text-lg font-semibold text-gray-900">Orders ({orders.length})</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-100 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold text-gray-900">Order ID</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-900">Site</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-900">Date</th>
                  <th className="px-4 py-3 text-center font-semibold text-gray-900">Items</th>
                  <th className="px-4 py-3 text-right font-semibold text-gray-900">Total</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-900">Status</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-900">Domain</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-900">Amazon</th>
                </tr>
              </thead>
              <tbody>
                {orders.map(order => (
                  <tr key={order.id} className="border-b hover:bg-gray-50 transition">
                    <td className="px-4 py-3 font-medium text-gray-900">{order.id}</td>
                    <td className="px-4 py-3 text-gray-700">{order.siteName}</td>
                    <td className="px-4 py-3 text-gray-700">{order.date}</td>
                    <td className="px-4 py-3 text-center text-gray-700">{order.itemCount}</td>
                    <td className="px-4 py-3 text-right font-semibold text-gray-900">${order.total.toFixed(2)}</td>
                    <td className="px-4 py-3">
                      <select
                        value={order.status}
                        onChange={(e) => {
                          setOrders(orders.map(o => o.id === order.id ? { ...o, status: e.target.value } : o));
                        }}
                        className="px-2 py-1 rounded text-xs font-medium bg-white border border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="Pending Review">Pending Review</option>
                        <option value="Approved">Approved</option>
                        <option value="Ordered">Ordered</option>
                        <option value="Shipped">Shipped</option>
                        <option value="Delivered">Delivered</option>
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-1 rounded text-xs font-medium ${
                        order.domain === 'SUPPLIES' ? 'bg-blue-100 text-blue-800' :
                        order.domain === 'FFE' ? 'bg-green-100 text-green-800' :
                        'bg-orange-100 text-orange-800'
                      }`}>
                        {order.domain}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {order.amazonBatches && order.amazonBatches.length > 0 ? (
                        <div className="flex gap-1">
                          {order.amazonBatches.map((batch, bi) => (
                            <button key={bi} onClick={() => submitAmazonCart(batch.formFields)}
                              className="inline-flex items-center gap-1 px-2 py-1 bg-amber-100 text-amber-800 rounded text-xs font-medium hover:bg-amber-200 transition cursor-pointer"
                            >
                              <ShoppingCart size={10} />
                              {order.amazonBatches.length > 1 ? `Cart ${bi+1}` : 'Amazon Cart'}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <span className="text-xs text-gray-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  };

  // ============================================================================
  // RENDER MAIN APP
  // ============================================================================

  return (
    <div className="flex h-screen bg-gray-100">
      <div className="w-64 bg-gradient-to-b from-[#0F1729] to-[#1a2a4a] text-white shadow-xl flex flex-col">
        <div className="p-6 border-b border-blue-900">
          <div className="flex items-center gap-3 mb-1">
            <span className="text-3xl">⚔️</span>
            <div>
              <h1 className="text-2xl font-bold text-[#D4AF37]">JASON</h1>
              <p className="text-xs text-blue-200 leading-tight">Joint Automated Supply</p>
              <p className="text-xs text-blue-200 leading-tight">Ordering Network</p>
            </div>
          </div>
        </div>

        <nav className="flex-1 p-4 space-y-2">
          {[
            { id: 'dashboard', label: 'Dashboard', icon: Home },
            { id: 'order-builder', label: 'Order Builder', icon: ShoppingCart },
            { id: 'mic', label: 'Master Item Catalogue', icon: FileText },
            { id: 'sites', label: 'School Sites', icon: MapPin },
            { id: 'orders', label: 'Orders', icon: Truck }
          ].map(item => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                onClick={() => setCurrentPage(item.id)}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition ${
                  currentPage === item.id
                    ? 'bg-[#D4AF37] text-[#0F1729] font-semibold shadow-md'
                    : 'text-blue-100 hover:bg-blue-800'
                }`}
              >
                <Icon size={20} />
                <span className="text-sm">{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-blue-900 text-center">
          <p className="text-xs text-blue-300 font-semibold">J.R. Houston</p>
          <p className="text-xs text-blue-300">VP of Operations</p>
          <p className="text-xs text-blue-400 mt-2">Alpha School</p>
        </div>
      </div>

      <div className="flex-1 flex flex-col">
        <div className="bg-white shadow-sm p-6 border-b border-gray-200">
          <h2 className="text-2xl font-bold text-[#1A5CB5]">
            {currentPage === 'dashboard' && 'Dashboard'}
            {currentPage === 'order-builder' && 'Order Builder'}
            {currentPage === 'mic' && 'Master Item Catalogue'}
            {currentPage === 'sites' && 'School Sites'}
            {currentPage === 'orders' && 'Orders'}
          </h2>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {currentPage === 'dashboard' && <DashboardPage />}
          {currentPage === 'order-builder' && <OrderBuilderPage />}
          {currentPage === 'mic' && <MICPage />}
          {currentPage === 'sites' && <SitesPage />}
          {currentPage === 'orders' && <OrdersPage />}
        </div>
      </div>

      <div className="fixed bottom-6 right-6 z-50 w-96 flex flex-col items-end">
        {showChat && (
          <div className="bg-white rounded-lg shadow-2xl flex flex-col h-96 w-full mb-4 border border-gray-200">
            <div className="bg-[#1A5CB5] text-white p-4 rounded-t-lg flex justify-between items-center">
              <span className="font-semibold flex items-center gap-2">
                <MessageSquare size={18} />
                JASON Chat
              </span>
              <button onClick={() => setShowChat(false)} className="hover:bg-blue-700 p-1 rounded transition">
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-gray-50">
              {chatMessages.map(msg => (
                <div key={msg.id} className={`flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-xs px-4 py-2 rounded-lg ${
                    msg.sender === 'user'
                      ? 'bg-[#1A5CB5] text-white rounded-br-none'
                      : 'bg-gray-300 text-gray-900 rounded-bl-none'
                  }`}>
                    <p className="text-sm whitespace-pre-wrap">{msg.text}</p>
                  </div>
                </div>
              ))}
              {chatLoading && (
                <div className="flex justify-start">
                  <div className="max-w-xs px-4 py-2 rounded-lg bg-gray-300 text-gray-900 rounded-bl-none">
                    <p className="text-sm flex items-center gap-2">
                      <span className="inline-block w-2 h-2 bg-gray-500 rounded-full animate-pulse"></span>
                      <span className="inline-block w-2 h-2 bg-gray-500 rounded-full animate-pulse" style={{animationDelay: '0.2s'}}></span>
                      <span className="inline-block w-2 h-2 bg-gray-500 rounded-full animate-pulse" style={{animationDelay: '0.4s'}}></span>
                    </p>
                  </div>
                </div>
              )}
            </div>
            <div className="border-t p-4 bg-white rounded-b-lg flex gap-2">
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleChatSubmit()}
                placeholder={chatLoading ? "Jason is thinking..." : "Ask me anything..."}
                disabled={chatLoading}
                className="flex-1 px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm disabled:bg-gray-100"
              />
              <button
                onClick={handleChatSubmit}
                disabled={chatLoading}
                className="bg-[#1A5CB5] hover:bg-blue-700 disabled:bg-gray-400 text-white p-2 rounded transition"
              >
                <Send size={18} />
              </button>
            </div>
          </div>
        )}

        <button
          onClick={() => setShowChat(!showChat)}
          className="w-full bg-[#1A5CB5] hover:bg-blue-700 text-white rounded-full py-3 flex items-center justify-center gap-2 shadow-lg transition font-semibold relative"
        >
          <MessageSquare size={20} />
          <span>Chat with JASON</span>
          {chatMessages.filter(m => m.sender === 'jason').length > 1 && (
            <span className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full w-6 h-6 flex items-center justify-center text-xs font-bold">
              {chatMessages.filter(m => m.sender === 'jason').length - 1}
            </span>
          )}
        </button>
      </div>
    </div>
  );
}
