// Tectobox frontend — views/products.js.
// Phase 5 modular restructure: split out of the 6,132-line app.js monolith.
// Classic script (NOT an ES module): functions/globals here are shared with
// every other frontend file via the global scope, and index.html loads them
// in dependency order. Do not rename anything — 423 element IDs in
// index.html and inline onclick handlers depend on these exact names.

// ---------------- client: products ----------------
function renderProductGrid() {
  const box = $('product-grid'), empty = $('products-empty');
  if (!state.products.length) {
    box.innerHTML = '';
    empty.innerHTML = `<div class="empty-state fade-in">
      <div class="ic"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg></div>
      <h3>No products yet</h3>
      <p>Add the products you sell — the AI will quote their real prices,<br>and photos customers send will be matched against them.</p>
    </div>`;
    return;
  }
  empty.innerHTML = '';
  box.innerHTML = state.products.map(p => {
    const stockCls = p.stock === 0 ? 'stock-out' : p.stock < 5 ? 'stock-low' : 'stock-ok';
    const stockTx = p.stock === 0 ? 'Out of stock' : p.stock < 5 ? `Low stock (${p.stock})` : `In stock (${p.stock})`;
    return `
    <div class="prod-card fade-in">
      <div class="nm">${esc(p.name)}</div>
      <div class="sku">${esc(p.sku)}</div>
      ${p.category ? `<span class="pill blue cat">${esc(p.category)}</span>` : ''}
      <div class="price">${Number(p.price_bdt).toLocaleString('en-US')} BDT</div>
      <div class="stock ${stockCls}">● ${stockTx}</div>
      <div class="row">
        <button class="mini-btn" data-pedit="${p.id}">Edit</button>
        <button class="mini-btn danger" data-pdel="${p.id}">Delete</button>
      </div>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-pedit]').forEach(b => b.onclick = () => openProductModal(Number(b.dataset.pedit)));
  box.querySelectorAll('[data-pdel]').forEach(b => b.onclick = async () => {
    if (!await askConfirm('Delete product?', 'This removes the product from your catalog. The AI will stop mentioning it.', 'Delete', true)) return;
    await api('/api/products/' + b.dataset.pdel, { method: 'DELETE' });
    loadProducts();
  });
}
function openProductModal(id) {
  const p = id ? state.products.find(x => x.id === id) : null;
  state.editingProductId = id || null;
  $('pm-title').textContent = id ? 'Edit product' : 'Add product';
  $('pm-sku').value = p ? p.sku : ''; $('pm-name').value = p ? p.name : '';
  $('pm-category').value = p ? (p.category || '') : '';
  $('pm-price').value = p ? p.price_bdt : ''; $('pm-stock').value = p ? p.stock : '';
  $('pm-image').value = p ? (p.image_url || '') : '';
  $('product-modal').classList.remove('hidden');
}
async function saveProductModal() {
  const sku = $('pm-sku').value.trim(), name = $('pm-name').value.trim();
  const price = Number($('pm-price').value);
  if (!sku || !name || !($('pm-price').value.trim()) || isNaN(price)) return toast('SKU, name and price are required', 'err');
  const sanitizedPrice = Math.max(0, price);
  const sanitizedStock = Math.max(0, Number($('pm-stock').value) || 0);
  try {
    if (state.editingProductId) {
      await api('/api/products/' + state.editingProductId, {
        method: 'PATCH',
        body: JSON.stringify({
          sku, name, category: $('pm-category').value.trim() || null,
          price_bdt: sanitizedPrice, stock: sanitizedStock,
          image_url: $('pm-image').value.trim() || null,
        }),
      });
    } else {
      await api('/api/products', {
        method: 'POST',
        body: JSON.stringify({
          sku, name, category: $('pm-category').value.trim() || null,
          price_bdt: sanitizedPrice, stock: sanitizedStock,
          image_url: $('pm-image').value.trim() || null,
        }),
      });
    }
    $('product-modal').classList.add('hidden');
    loadProducts();
  } catch (e) { toast('Could not save: ' + e.message, 'err'); }
}
