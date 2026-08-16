// ==========================================
// ملف script.js الكامل والنهائي لتطبيق صالون نوسا (مع إضافة خيارات الشحن والعنوان)

/* ========================= NOSA PRO REALTIME SYNC ========================= */
const NOSA_PRO_SYNC = {
    lastSync: 0,
    timer: null,
    busy: false,
    async run(reason = 'update') {
        if (this.busy) return;
        this.busy = true;
        try {
            // Re-use the existing project functions instead of duplicating Firebase queries.
            if (typeof refreshVisibleDataAfterFirebaseUpdate === 'function') {
                refreshVisibleDataAfterFirebaseUpdate();
            }
            if (typeof updateAdminDashboard === 'function') {
                try { await updateAdminDashboard(); } catch (_) {}
            }
            if (typeof loadNosaOverview === 'function' && document.getElementById('nosa-view')) {
                try { await loadNosaOverview(); } catch (_) {}
            }
            this.lastSync = Date.now();
            document.documentElement.dataset.lastSync = String(this.lastSync);
            const el = document.getElementById('nosa-live-status');
            if (el) {
                el.textContent = '● مباشر';
                el.classList.add('live');
            }
        } finally {
            this.busy = false;
        }
    },
    schedule(reason='update') {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.run(reason), 80);
    }
};

window.NOSA_PRO_SYNC = NOSA_PRO_SYNC;

// Patch common Firebase write methods so the UI updates immediately after successful writes.
// Existing database listeners remain the source of truth.
(function patchFirebaseWrites(){
    const tryPatch = () => {
        if (!window.firebase || !firebase.database || !firebase.database.DatabaseReference) return false;
        const proto = firebase.database.DatabaseReference.prototype;
        ['set','update','remove','transaction'].forEach(method => {
            const original = proto[method];
            if (!original || original.__nosaPatched) return;
            const wrapped = function(...args) {
                let p;
                try { p = original.apply(this,args); }
                catch(e) { throw e; }
                if (p && typeof p.then === 'function') {
                    return p.then(result => {
                        NOSA_PRO_SYNC.schedule(method);
                        return result;
                    });
                }
                NOSA_PRO_SYNC.schedule(method);
                return p;
            };
            wrapped.__nosaPatched = true;
            proto[method] = wrapped;
        });
        return true;
    };
    if (!tryPatch()) {
        const wait = setInterval(() => { if (tryPatch()) clearInterval(wait); }, 250);
        setTimeout(() => clearInterval(wait), 15000);
    }
})();

// Cross-tab sync: if the same admin opens two tabs, a successful change in one tab
// prompts the other tab to refresh its visible data.
window.addEventListener('storage', e => {
    if (e.key === 'nosa-pro-sync') NOSA_PRO_SYNC.schedule('cross-tab');
});
function broadcastNosaSync(reason='update'){
    try {
        localStorage.setItem('nosa-pro-sync', JSON.stringify({t:Date.now(),reason}));
    } catch (_) {}
}


// ==========================================

let currentUser = JSON.parse(sessionStorage.getItem('salon_current_user')) || null;
let userRole = sessionStorage.getItem('salon_user_role') || null; 

const validAccounts = {
    "nosa@salon.com": { pass: "nosa150180", role: "nosa", name: "نوسا (Master Admin)" },
    "dokki@salon.com": { pass: "dokki2526", role: "dokki", name: "مدير فرع الدواجن" },
    "haddayek@salon.com": { pass: "haddayek20240", role: "haddayek", name: "مدير فرع الحدائق" },
    "admin@salon.com": { pass: "admin9050", role: "admin", name: "أدمن المنتجات والعروض" }
};

let appData = JSON.parse(localStorage.getItem('salon_app_data')) || {
    services: [
        { id: '1', name: 'قص وتدريج شعر', branchId: 'dokki', price: 150, max: 10, currentCount: 0, codePrefix: 'NOSA' }
    ],
    products: [
        { id: '1', name: 'سيروم للشعر', branchId: 'dokki', price: 250, qty: 15, max: 15, currentCount: 0, codePrefix: 'NOSA' }
    ],
    wallets: [
        { id: '1', branchId: 'dokki', name: 'فودافون كاش الدواجن', number: '01012345678' },
        { id: '2', branchId: 'haddayek', name: 'فودافون كاش الحدائق', number: '01298765432' }
    ],
    shippingRates: {
        dokki: { pickup: 0, local: 30, regional: 60 },
        haddayek: { pickup: 0, local: 30, regional: 60 }
    },
    bookings: [],
    invoices: [],
    closedDays: [],
    branchPrefixIndices: {
        dokki: {},
        haddayek: {}
    },
    accountPasswords: {
        "nosa@salon.com": "nosa150180",
        "dokki@salon.com": "dokki2526",
        "haddayek@salon.com": "haddayek20240",
        "admin@salon.com": "admin9050"
    }
};

// ==========================================================
// Firebase Realtime Database - مزامنة لحظية وآمنة
// ==========================================================
// مهم: هذا الجزء مضاف فقط للمزامنة، ولا يلغي أي وظيفة موجودة
// في المشروع. localStorage يظل موجوداً كنسخة احتياطية محلية.
// ==========================================================

const FIREBASE_DATABASE_URL = 'https://salonnosa-d350f-default-rtdb.europe-west1.firebasedatabase.app';

let firebaseDb = null;
let firebaseDataRef = null;
let firebaseSyncStarted = false;
let firebaseReady = false;
let firebaseApplyingRemote = false;
let firebaseLastSyncedData = null;
let firebaseDirtyKeys = new Set();
let firebaseLocalBaseline = null;

function cloneData(data) {
    try { return JSON.parse(JSON.stringify(data)); }
    catch (error) { console.error('Firebase clone error:', error); return null; }
}

function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') return Object.keys(value).map(k => value[k]).filter(v => v != null);
    return [];
}

function normalizeAppData(data) {
    const d = (data && typeof data === 'object') ? data : {};
    d.services = asArray(d.services);
    d.products = asArray(d.products);
    [...d.services, ...d.products].forEach(item => {
        const basePrice = Number(item.price || 0);
        if (!Number.isFinite(Number(item.priceMin))) item.priceMin = basePrice;
        if (!Number.isFinite(Number(item.priceMax))) item.priceMax = basePrice;
        if (item.priceMode !== 'range') item.priceMode = 'single';
        if (item.priceMode === 'single') { item.priceMin = basePrice; item.priceMax = basePrice; }
    });
    d.wallets = asArray(d.wallets);
    d.bookings = asArray(d.bookings);
    d.invoices = asArray(d.invoices);
    d.closedDays = asArray(d.closedDays);
    d.branchPrefixIndices = (d.branchPrefixIndices && typeof d.branchPrefixIndices === 'object') ? d.branchPrefixIndices : { dokki:{}, haddayek:{} };
    d.branchPrefixIndices.dokki = d.branchPrefixIndices.dokki || {};
    d.branchPrefixIndices.haddayek = d.branchPrefixIndices.haddayek || {};
    d.accountPasswords = (d.accountPasswords && typeof d.accountPasswords === 'object') ? d.accountPasswords : {};
    // كلمة المرور الفعلية لكل حساب تُقرأ من accountPasswords.
    // القيم الافتراضية تُستخدم فقط لأول إنشاء للبيانات، وبعد ذلك لا يوجد fallback
    // إلى validAccounts عند تسجيل الدخول، حتى لا يظل الباسورد القديم صالحًا.
    const defaultAccountPasswords = {
        "nosa@salon.com": validAccounts["nosa@salon.com"].pass,
        "dokki@salon.com": validAccounts["dokki@salon.com"].pass,
        "haddayek@salon.com": validAccounts["haddayek@salon.com"].pass,
        "admin@salon.com": validAccounts["admin@salon.com"].pass
    };
    Object.keys(defaultAccountPasswords).forEach(email => {
        if (typeof d.accountPasswords[email] !== 'string' || !d.accountPasswords[email]) {
            d.accountPasswords[email] = defaultAccountPasswords[email];
        }
    });
    d.shippingRates = (d.shippingRates && typeof d.shippingRates === 'object') ? d.shippingRates : {};
    if (!d.shippingRates.dokki) d.shippingRates.dokki = {pickup:0,local:30,regional:60};
    if (!d.shippingRates.haddayek) d.shippingRates.haddayek = {pickup:0,local:30,regional:60};
    return d;
}

function saveData() {
    appData = normalizeAppData(appData);
    localStorage.setItem('salon_app_data', JSON.stringify(appData));

    if (!firebaseDataRef || firebaseApplyingRemote) return;

    // مزامنة جزئية: نرسل فقط الأقسام التي تغيّرت، حتى لا يكتب جهازٌ
    // بيانات قديمة فوق إضافة جديدة قام بها جهاز آخر. هذا مهم خصوصاً للخدمات والمنتجات.
    const baseline = firebaseReady ? (firebaseLastSyncedData || firebaseLocalBaseline || {}) : (firebaseLocalBaseline || {});
    const changed = {};
    Object.keys(appData).forEach(key => {
        if (JSON.stringify(appData[key]) !== JSON.stringify(baseline[key])) {
            changed[key] = cloneData(appData[key]);
            firebaseDirtyKeys.add(key);
        }
    });

    if (!firebaseReady) return;
    const keys = Object.keys(changed);
    if (!keys.length) return;

    firebaseApplyingRemote = true;
    firebaseDataRef.update(changed)
        .then(() => {
            // نحدّث نسخة المزامنة محلياً لكل قسم أرسلناه فقط.
            firebaseLastSyncedData = firebaseLastSyncedData || {};
            keys.forEach(key => { firebaseLastSyncedData[key] = cloneData(appData[key]); });
            keys.forEach(key => firebaseDirtyKeys.delete(key));
        })
        .catch(err => console.error('Firebase partial save error:', err))
        .finally(() => { firebaseApplyingRemote = false; });
}

function refreshVisibleDataAfterFirebaseUpdate() {
    try {
        // الإدارة: حدّث الشاشة المفتوحة حالياً بدون Reload.
        if (currentUser && userRole) {
            if (userRole === 'nosa') loadNosaOverview();
            else if (userRole === 'admin') {
                if (document.getElementById('admin-payments-table')) renderAdminPaymentsTable();
                if (document.getElementById('wallets-admin-list')) renderWalletsList();
                if (document.getElementById('admin-services-list')) renderAdminServicesTable();
            } else if (userRole === 'dokki' || userRole === 'haddayek') {
                loadBranchOffersView(userRole);
            }
        }

        // بوابة العميل: أعد تحميل القوائم والرصيد/الأسعار والنتائج المعروضة فور وصول أي تغيير.
        if (document.getElementById('client-view')?.classList.contains('active')) {
            const branch = document.getElementById('cs-branch')?.value || 'dokki';
            loadClientServices(branch);
            loadClientProducts(document.getElementById('cp-branch')?.value || branch);
            loadClientWallets(branch, 'cs');
            loadClientWallets(document.getElementById('cp-branch')?.value || branch, 'cp');
            updateClientProductTotalCalculation();
            if (window.NOSA_SERVICE_FEEDBACK) {
                try { window.NOSA_SERVICE_FEEDBACK.loadBookings?.(); } catch (_) {}
            }

            const phone = document.getElementById('ct-phone')?.value?.trim();
            if (phone && document.getElementById('track-result-area')?.innerHTML) {
                const trackForm = document.getElementById('client-track-form');
                if (trackForm) trackForm.dispatchEvent(new Event('submit', {cancelable:true}));
            }
        }
    } catch (error) { console.error('Firebase UI refresh error:', error); }
}
window.nosaRefreshNow = () => NOSA_PRO_SYNC.schedule('firebase');


function startFirebaseRealtimeSync() {
    if (firebaseSyncStarted || typeof firebase === 'undefined') return;
    try {
        if (!firebase.apps.length) firebase.initializeApp({ databaseURL: FIREBASE_DATABASE_URL });
        firebaseDb = firebase.database();
        firebaseDataRef = firebaseDb.ref('salonAppData');
        firebaseSyncStarted = true;

        // نأخذ لقطة محلية قبل التحميل حتى نعرف أي تعديلات تمت أثناء الانتظار.
        const localBeforeLoad = cloneData(appData);
        firebaseLocalBaseline = cloneData(appData);

        firebaseDataRef.once('value').then(snapshot => {
            const cloud = snapshot.val();
            let baseData;

            if (!cloud || typeof cloud !== 'object' || Object.keys(cloud).length === 0) {
                baseData = normalizeAppData(localBeforeLoad);
            } else {
                baseData = normalizeAppData(cloneData(cloud));
            }

            // أي قسم عُدّل أثناء تحميل Firebase له الأولوية، حتى لا يضيع إدخال المسؤول.
            firebaseDirtyKeys.forEach(key => {
                baseData[key] = cloneData(appData[key]);
            });

            appData = normalizeAppData(baseData);
            localStorage.setItem('salon_app_data', JSON.stringify(appData));
            firebaseLastSyncedData = cloneData(appData);
            firebaseReady = true;
            firebaseDirtyKeys.clear();

            firebaseApplyingRemote = true;
            const initialPublish = {};
            firebaseDirtyKeys.forEach(key => { initialPublish[key] = cloneData(appData[key]); });
            return Object.keys(initialPublish).length ? firebaseDataRef.update(initialPublish) : Promise.resolve();
        }).then(() => {
            firebaseApplyingRemote = false;
            firebaseLastSyncedData = cloneData(appData);
            refreshVisibleDataAfterFirebaseUpdate();

            // المستمع يبدأ بعد التحميل الأول، وبالتالي لا يستطيع أن يطغى على إضافة جديدة.
            firebaseDataRef.on('value', snapshot => {
                if (firebaseApplyingRemote) return;
                const remote = snapshot.val();
                if (!remote || typeof remote !== 'object') return;
                const incoming = normalizeAppData(cloneData(remote));
                // لو كان هناك قسم محلي قيد الحفظ، لا نسمح للّقطة الواردة أن تطغى عليه.
                firebaseDirtyKeys.forEach(key => {
                    incoming[key] = cloneData(appData[key]);
                });
                appData = incoming;
                localStorage.setItem('salon_app_data', JSON.stringify(appData));
                firebaseLastSyncedData = cloneData(appData);
                refreshVisibleDataAfterFirebaseUpdate();
            });
        }).catch(error => {
            firebaseApplyingRemote = false;
            console.error('Firebase sync error:', error);
            firebaseReady = true;
        });
    } catch (error) {
        console.error('Firebase initialization error:', error);
        firebaseSyncStarted = false;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    initEventListeners();

    // تشغيل المزامنة فور فتح الموقع.
    startFirebaseRealtimeSync();

    if (currentUser && userRole) {
        renderDashboard();
    } else {
        switchView('auth-view');
    }
});

function switchView(viewId) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const target = document.getElementById(viewId);
    if(target) target.classList.add('active');
}

function initEventListeners() {
    const loginForm = document.getElementById('login-form');
    if (loginForm) {
        loginForm.onsubmit = function(e) {
            e.preventDefault();
            const email = document.getElementById('login-email').value.trim().toLowerCase();
            const password = document.getElementById('login-password').value.trim();

            // انتظر أول مزامنة من Firebase قبل قبول تسجيل الدخول، حتى لا يتم
            // استخدام نسخة localStorage قديمة وتسمح مؤقتًا بالباسورد القديم.
            if (firebaseSyncStarted && !firebaseReady) {
                alert('جاري التحقق من بيانات الدخول الحالية... حاول مرة أخرى بعد لحظات.');
                return;
            }

            // بعد تغيير كلمة المرور من نوسا، الباسورد القديم لا يتم قبوله.
            // لا نستخدم validAccounts[email].pass كـ fallback أثناء تسجيل الدخول.
            const storedPass = appData.accountPasswords?.[email];
            if (validAccounts[email] && typeof storedPass === 'string' && storedPass === password) {
                currentUser = { email: email };
                userRole = validAccounts[email].role;
                sessionStorage.setItem('salon_current_user', JSON.stringify(currentUser));
                sessionStorage.setItem('salon_user_role', userRole);
                renderDashboard();
            } else {
                alert('خطأ في البريد الإلكتروني أو كلمة المرور غير صحيحة!');
            }
        };
    }

    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.onclick = function() {
            currentUser = null;
            userRole = null;
            sessionStorage.clear();
            if(document.getElementById('login-form')) document.getElementById('login-form').reset();
            switchView('auth-view');
        };
    }

    const showClientPortal = document.getElementById('show-client-portal');
    if (showClientPortal) {
        showClientPortal.onclick = function() {
            switchView('client-view');
            nosaOpenClientTab?.('client-home');
            NOSA_PRO_COMM?.saveAccount?.();
            nosaUpdateHomeSummary?.();
            initClientPortalData();
            setTimeout(()=>{ if(window.nosaInitCommunicationCenter) nosaInitCommunicationCenter(); if(window.nosaInitServiceFeedback) nosaInitServiceFeedback(); },150);
        };
    }

    const backToLogin = document.getElementById('back-to-login');
    if (backToLogin) {
        backToLogin.onclick = function() {
            switchView('auth-view');
        };
    }

    document.querySelectorAll('.client-tabs .tab-btn').forEach(btn => {
        btn.onclick = function(e) {
            document.querySelectorAll('.client-tabs .tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.client-tab-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            const targetId = btn.getAttribute('data-tab');
            document.getElementById(targetId)?.classList.add('active');
            nosaOpenClientTab?.(targetId);
        };
    });

    const csBranch = document.getElementById('cs-branch');
    if (csBranch) {
        csBranch.onchange = function(e) {
            loadClientServices(e.target.value);
            loadClientWallets(e.target.value, 'cs');
        };
    }

    const csPaymentMethod = document.getElementById('cs-payment-method');
    if (csPaymentMethod) {
        csPaymentMethod.onchange = function(e) {
            const box = document.getElementById('cs-wallet-info-box');
            if (box) {
                if (e.target.value === 'wallet') box.classList.remove('hidden');
                else box.classList.add('hidden');
            }
        };
    }

    const cpBranch = document.getElementById('cp-branch');
    if (cpBranch) {
        cpBranch.onchange = function(e) {
            loadClientProducts(e.target.value);
            loadClientWallets(e.target.value, 'cp');
            updateClientProductTotalCalculation();
        };
    }

    const cpProductSelect = document.getElementById('cp-product');
    if (cpProductSelect) {
        cpProductSelect.onchange = function() {
            updateClientProductTotalCalculation();
        };
    }

    const cpQtyInput = document.getElementById('cp-qty');
    if (cpQtyInput) {
        cpQtyInput.oninput = function() {
            updateClientProductTotalCalculation();
        };
    }

    const cpDeliveryType = document.getElementById('cp-delivery-type');
    if (cpDeliveryType) {
        cpDeliveryType.onchange = function(e) {
            const addressGroup = document.getElementById('cp-address-group');
            const val = e.target.value;
            if (addressGroup) {
                if (val === 'pickup') {
                    addressGroup.classList.add('hidden');
                } else {
                    addressGroup.classList.remove('hidden');
                }
            }
            updateClientProductTotalCalculation();
        };
    }

    const cpPaymentMethod = document.getElementById('cp-payment-method');
    if (cpPaymentMethod) {
        cpPaymentMethod.onchange = function(e) {
            const box = document.getElementById('cp-wallet-info-box');
            if (box) {
                if (e.target.value === 'wallet') box.classList.remove('hidden');
                else box.classList.add('hidden');
            }
        };
    }

    const clientServiceForm = document.getElementById('client-service-form');
    if (clientServiceForm) {
        clientServiceForm.onsubmit = function(e) {
            e.preventDefault();
            const branchId = document.getElementById('cs-branch').value;
            const serviceId = document.getElementById('cs-service').value;
            
            const serviceObj = appData.services.find(s => s.id === serviceId);

            if (!serviceObj || serviceObj.max <= 0) {
                alert('عذراً، هذه الخدمة غير متاحة أو اكتمل عددها.');
                return;
            }

            if (serviceObj.currentCount === undefined) serviceObj.currentCount = 0;
            if (!serviceObj.codePrefix) serviceObj.codePrefix = 'NOSA';

            serviceObj.currentCount = Math.max(0, Number(serviceObj.currentCount || 0) + 1);
            serviceObj.max = Math.max(0, Number(serviceObj.max || 0) - 1);

            let cleanPrefix = serviceObj.codePrefix.trim().toUpperCase();
            let uniqueBookingNumber = `${cleanPrefix}-${serviceObj.currentCount}`;

            const payMethod = document.getElementById('cs-payment-method').value;

            const newBooking = {
                id: 'B-' + Date.now(),
                type: 'حجز خدمة',
                customerName: document.getElementById('cs-name').value,
                customerPhone: document.getElementById('cs-phone').value.trim(),
                branchId: branchId,
                itemId: serviceObj.id,
                itemName: `${serviceObj.name}`,
                price: serviceObj.price,
                priceMode: getItemPriceMode(serviceObj),
                priceMin: getItemPriceMin(serviceObj),
                priceMax: getItemPriceMax(serviceObj),
                selectedPrice: getItemPriceMode(serviceObj) === 'range' ? null : Number(serviceObj.price),
                shippingCost: 0,
                totalAmount: getItemPriceMode(serviceObj) === 'range' ? null : Number(serviceObj.price),
                paymentMethod: payMethod,
                paymentStatus: 'جاري المراجعة',
                orderStatus: 'قيد المراجعة',
                bookingNumber: uniqueBookingNumber,
                codePrefix: cleanPrefix,
                quantity: 1,
                deliveryType: 'pickup',
                deliveryTypeName: 'استلام من الصالون',
                address: '-'
            };

            appData.bookings.push(newBooking);
            saveData();
            showTicketModal(newBooking);
            clientServiceForm.reset();
            loadClientServices(branchId);
        };
    }

    const clientProductForm = document.getElementById('client-product-form');
    if (clientProductForm) {
        clientProductForm.onsubmit = function(e) {
            e.preventDefault();
            const branchId = document.getElementById('cp-branch').value;
            const productId = document.getElementById('cp-product').value;
            const productQtyInput = document.getElementById('cp-qty');
            const requestedQty = productQtyInput ? parseInt(productQtyInput.value) || 1 : 1;

            const productObj = appData.products.find(p => p.id === productId);

            if (!productObj || productObj.qty < requestedQty) {
                alert(`عذراً، الكمية المطلوبة غير متوفرة في المخزن. المتبقي: ${productObj ? productObj.qty : 0}`);
                return;
            }

            const deliveryType = document.getElementById('cp-delivery-type').value;
            const addressVal = document.getElementById('cp-address').value.trim();

            if (deliveryType !== 'pickup' && !addressVal) {
                alert('يرجى إدخال عنوان التوصيل بالتفصيل.');
                return;
            }

            if (productObj.currentCount === undefined) productObj.currentCount = 0;
            if (!productObj.codePrefix) productObj.codePrefix = 'NOSA';

            let nextSeq = productObj.currentCount + 1;
            productObj.currentCount = Math.max(0, Number(productObj.currentCount || 0) + requestedQty);
            productObj.qty = Math.max(0, Number(productObj.qty || 0) - requestedQty);

            let cleanPrefix = productObj.codePrefix.trim().toUpperCase();
            let uniqueBookingNumber = `${cleanPrefix}-${nextSeq}`;

            const payMethod = document.getElementById('cp-payment-method').value;
            const productsSubtotal = productObj.price * requestedQty;

            if (!appData.shippingRates) appData.shippingRates = { dokki: { pickup: 0, local: 30, regional: 60 }, haddayek: { pickup: 0, local: 30, regional: 60 } };
            if (!appData.shippingRates[branchId]) appData.shippingRates[branchId] = { pickup: 0, local: 30, regional: 60 };
            
            const shippingFee = appData.shippingRates[branchId][deliveryType] || 0;
            const grandTotal = productsSubtotal + shippingFee;

            let deliveryTypeNameText = 'استلام من الصالون';
            if (deliveryType === 'local') deliveryTypeNameText = 'توصيل داخل القاهرة';
            else if (deliveryType === 'regional') deliveryTypeNameText = 'شحن محافظات';

            const newBooking = {
                id: 'B-' + Date.now(),
                type: 'حجز منتجات',
                customerName: document.getElementById('cp-name').value,
                customerPhone: document.getElementById('cp-phone').value.trim(),
                branchId: branchId,
                itemId: productObj.id,
                itemName: `${productObj.name}`,
                price: productsSubtotal,
                shippingCost: shippingFee,
                totalAmount: grandTotal,
                paymentMethod: payMethod,
                paymentStatus: 'جاري المراجعة',
                orderStatus: 'يتم تجهيز الأوردر',
                bookingNumber: uniqueBookingNumber,
                codePrefix: cleanPrefix,
                quantity: requestedQty,
                deliveryType: deliveryType,
                deliveryTypeName: deliveryTypeNameText,
                address: deliveryType === 'pickup' ? 'استلام من الفرع مباشرة' : addressVal
            };

            appData.bookings.push(newBooking);
            saveData();
            showTicketModal(newBooking);
            clientProductForm.reset();
            document.getElementById('cp-address-group').classList.add('hidden');
            loadClientProducts(branchId);
            updateClientProductTotalCalculation();
        };
    }

    const trackForm = document.getElementById('client-track-form');
    if (trackForm) {
        trackForm.onsubmit = function(e) {
            e.preventDefault();
            const phone = document.getElementById('ct-phone').value.trim();
            const selectedBranch = document.getElementById('ct-branch').value;
            const resultDiv = document.getElementById('track-result-area');
            
            const normalizePhone = v => String(v || '').replace(/[^0-9+]/g, '').trim();
            const searchPhone = normalizePhone(phone);
            let userBookings = (Array.isArray(appData.bookings) ? appData.bookings : []).filter(b => {
                const bp = normalizePhone(b.customerPhone || b.phone);
                return bp === searchPhone || (bp && searchPhone && bp.endsWith(searchPhone)) || (searchPhone && searchPhone.endsWith(bp));
            });
            if (selectedBranch) {
                userBookings = userBookings.filter(b => {
                    const bid = String(b.branchId || b.branch || '').toLowerCase();
                    return bid === String(selectedBranch).toLowerCase() ||
                           (selectedBranch === 'haddayek' && (bid.includes('hadd') || bid.includes('حد'))) ||
                           (selectedBranch === 'dokki' && (bid.includes('dok') || bid.includes('دق')));
                });
            }
            // لا نعرض الحجز أكثر من مرة إذا كان محفوظًا بأكثر من مرجع.
            const seen = new Set();
            userBookings = userBookings.filter(b => {
                const key = String(b.id || b.bookingNumber || '') + '|' + String(b.customerPhone || b.phone || '');
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });

            if (userBookings.length === 0) {
                resultDiv.innerHTML = '<p class="text-danger mt-3">لا توجد حجوزات نشطة مطابقة حالياً لهذا الرقم.</p>';
                return;
            }

            if (!appData.branchPrefixIndices) appData.branchPrefixIndices = { dokki: {}, haddayek: {} };

            let html = `<h4 class="mt-3">نتائج الاستعلام وموقف الحجوزات:</h4>`;
            
            userBookings.forEach(b => {
                const bName = (b.branchId === 'dokki') ? 'فرع الدواجن' : 'فرع الحدائق';
                const qtyDisplay = (b.type === 'حجز منتجات') ? `<span class="badge" style="background:#e67e22; color:#fff;">${b.quantity || 1} قطعة</span>` : `-`;
                
                let pCode = b.codePrefix || (b.bookingNumber.includes('-') ? b.bookingNumber.split('-')[0] : 'NOSA');
                let branchBookingsByPrefix = appData.bookings.filter(item => item.branchId === b.branchId && (item.codePrefix === pCode || item.bookingNumber.startsWith(pCode)));
                
                if (!appData.branchPrefixIndices[b.branchId]) appData.branchPrefixIndices[b.branchId] = {};
                if (appData.branchPrefixIndices[b.branchId][pCode] === undefined) {
                    appData.branchPrefixIndices[b.branchId][pCode] = 0;
                }
                
                let pIndex = appData.branchPrefixIndices[b.branchId][pCode];
                let currentServingCode = (branchBookingsByPrefix.length > 0 && branchBookingsByPrefix[pIndex]) ? branchBookingsByPrefix[pIndex].bookingNumber : 'لا يوجد حالياً';
                
                let queueStatusText = '';
                if (b.type === 'حجز خدمة') {
                    if (branchBookingsByPrefix.length > 0) {
                        let currentIndex = branchBookingsByPrefix.findIndex(item => item.bookingNumber === b.bookingNumber);
                        
                        if (currentIndex !== -1) {
                            let diff = currentIndex - pIndex;
                            if (diff === 0) {
                                queueStatusText = `<span class="badge" style="background:#27ae60; color:#fff; font-size:1rem; padding:6px 12px;">دورك الآن على الكرسي لهذا الكود! 🎉</span>`;
                            } else if (diff > 0) {
                                queueStatusText = `<span class="badge" style="background:#e67e22; color:#fff; font-size:1rem; padding:6px 12px;">باقي على دورك ضمن هذا الكود: ${diff} أشخاص</span>`;
                            } else {
                                queueStatusText = `<span class="badge" style="background:#7f8c8d; color:#fff;">تم تجاوز دورك أو انتهى لهذا الكود</span>`;
                            }
                        } else {
                            queueStatusText = `<span class="badge">قيد المعالجة</span>`;
                        }
                    } else {
                        queueStatusText = `<span class="badge">لا يوجد طابور لهذا الكود حالياً</span>`;
                    }
                }

                let dynamicDetailsHtml = '';
                if (b.type === 'حجز خدمة') {
                    dynamicDetailsHtml = `
                        <p><strong>الكود الحالي على الكرسي لكود (${pCode}):</strong> <span style="color:#c0392b; font-size:1.2rem; font-weight:bold;">${currentServingCode}</span></p>
                        ${(b.chairNumber || b.chair || b.seatNumber) ? `<p><strong>رقم الكرسي:</strong> ${b.chairNumber || b.chair || b.seatNumber}</p>` : ''}
                        <p class="mt-2"><strong>حالة دورك:</strong> ${queueStatusText}</p>
                    `;
                } else {
                    let currentOrderStatus = b.orderStatus || 'يتم تجهيز الأوردر';
                    let shippingInfoText = `طريقة الاستلام: <strong>${b.deliveryTypeName || 'استلام من الصالون'}</strong> | تكلفة الشحن: <strong>${b.shippingCost || 0} ج</strong>`;
                    dynamicDetailsHtml = `
                        <p class="mt-2">${shippingInfoText}</p>
                        <p class="mt-1"><strong>العنوان:</strong> ${b.address || '-'}</p>
                        <p class="mt-2"><strong>حالة الأوردر:</strong> <span class="badge" style="background:#2980b9; color:#fff; font-size:1rem; padding:6px 12px;">${currentOrderStatus}</span></p>
                    `;
                }

    
                html += `
                <div class="card mt-3" style="border-right: 5px solid var(--primary-dark);">
                    <p><strong>الفرع:</strong> ${bName}</p>
                    <p><strong>كود الحجز:</strong> <span style="color:var(--primary-dark); font-size:1.3rem;">${b.bookingNumber}</span> (بادئة الكود: <strong>${pCode}</strong>)</p>
                    <p><strong>الخدمة/المنتج:</strong> ${b.itemName} (${b.type})</p>
                    <p><strong>الكمية:</strong> ${qtyDisplay}</p>
                    <p><strong>إجمالي المطلوب (شامل الشحن إن وجد):</strong> <span style="color:#c0392b; font-weight:bold;">${Number(b.totalAmount ?? b.price ?? 0) + Number(b.shippingCost || 0)} جنيه</span></p>
                    <hr style="border:0; border-top:1px solid #eee; margin:10px 0;">
                    ${dynamicDetailsHtml}
                    <p class="mt-2 text-muted" style="font-size:0.9rem;">حالة الدفع: ${b.paymentStatus} (${b.paymentMethod === 'cash' ? 'كاش' : 'فودافون كاش'})</p>
                </div>`;
            });
            
            resultDiv.innerHTML = html;
        };
    }

    const closeTicketModal = document.getElementById('close-ticket-modal');
    if (closeTicketModal) {
        closeTicketModal.onclick = function() {
            document.getElementById('ticket-modal').classList.add('hidden');
        };
    }
}

function updateClientProductTotalCalculation() {
    const productSelect = document.getElementById('cp-product');
    const qtyInput = document.getElementById('cp-qty');
    const deliverySelect = document.getElementById('cp-delivery-type');
    const branchSelect = document.getElementById('cp-branch');
    const summaryBox = document.getElementById('cp-price-summary');

    if (!productSelect || !summaryBox) return;

    const productId = productSelect.value;
    const qty = qtyInput ? parseInt(qtyInput.value) || 1 : 1;
    const deliveryType = deliverySelect ? deliverySelect.value : 'pickup';
    const branchId = branchSelect ? branchSelect.value : 'dokki';

    const productObj = appData.products.find(p => p.id === productId);
    if (!productObj) {
        summaryBox.innerHTML = '';
        return;
    }

    const subtotal = getItemCalculationPrice(productObj) * qty;

    if (!appData.shippingRates) appData.shippingRates = { dokki: { pickup: 0, local: 30, regional: 60 }, haddayek: { pickup: 0, local: 30, regional: 60 } };
    if (!appData.shippingRates[branchId]) appData.shippingRates[branchId] = { pickup: 0, local: 30, regional: 60 };

    const shippingFee = appData.shippingRates[branchId][deliveryType] || 0;
    const total = subtotal + shippingFee;

    summaryBox.innerHTML = `
        <div style="background: #f8f9fa; border: 1px solid #ddd; padding: 10px; border-radius: 6px; margin-top: 10px; font-size: 0.95rem;">
            <p>سعر المنتجات: <strong>${subtotal} جنيه</strong></p>
            <p>تكلفة الشحن/التوصيل: <strong>${shippingFee} جنيه</strong></p>
            <hr style="margin: 5px 0; border:0; border-top:1px solid #ccc;">
            <p style="color: var(--primary-dark); font-size: 1.1rem;"><strong>الإجمالي الكلي: ${total} جنيه</strong></p>
        </div>
    `;
}

function initClientPortalData() {
    const defaultBranch = document.getElementById('cs-branch') ? document.getElementById('cs-branch').value : 'dokki';
    loadClientServices(defaultBranch);
    loadClientProducts(defaultBranch);
    loadClientWallets(defaultBranch, 'cs');
    loadClientWallets(defaultBranch, 'cp');
    updateClientProductTotalCalculation();
}

function loadClientServices(branchId) {
    const select = document.getElementById('cs-service');
    if (!select) return;
    select.innerHTML = '<option value="">اختر الخدمة المطلوبة والأكواد المتاحة...</option>';
    
    appData.services.filter(s => s.branchId === branchId).forEach(s => {
        if (s.max > 0) {
            let currentSeqNum = (s.currentCount || 0) + 1;
            let prefixCode = s.codePrefix || 'NOSA';
            let generatedCode = `${prefixCode}-${currentSeqNum}`;

            select.innerHTML += `<option value="${s.id}">
                ${s.name} - السعر: ${getItemPriceLabel(s)} - الكود المتاح: (${generatedCode}) - المتبقي: ${s.max}
            </option>`;
        }
    });
}

function loadClientProducts(branchId) {
    const select = document.getElementById('cp-product');
    if (!select) return;
    select.innerHTML = '<option value="">اختر المنتج المطلوب والأكواد المتاحة...</option>';
    
    appData.products.filter(p => p.branchId === branchId).forEach(p => {
        if (p.qty > 0) {
            let currentSeqNum = (p.currentCount || 0) + 1;
            let prefixCode = p.codePrefix || 'NOSA';
            let generatedCode = `${prefixCode}-${currentSeqNum}`;

            select.innerHTML += `<option value="${p.id}">
                ${p.name} - السعر: ${getItemPriceLabel(p)} - الكود المتاح: (${generatedCode}) - المتبقي بالمخزن: ${p.qty}
            </option>`;
        }
    });
}

function loadClientWallets(branchId, prefix) {
    const listDiv = document.getElementById(`${prefix}-wallets-list`);
    if (!listDiv) return;
    listDiv.innerHTML = '';
    const wallets = appData.wallets.filter(w => w.branchId === branchId);
    if (wallets.length === 0) {
        listDiv.innerHTML = '<p>لا توجد محافظ مسجلة.</p>';
        return;
    }
    wallets.forEach(w => {
        listDiv.innerHTML += `<p>${w.name}: <strong style="color:var(--primary-dark);">${w.number}</strong></p>`;
    });
}

function showTicketModal(bData) {
    const content = document.getElementById('ticket-details-content');
    if(!content) return;
    const isRangeBooking = bData.type === 'حجز خدمة' && bData.priceMode === 'range';
    const hasValidSelectedPrice = isRangeBooking && Number.isFinite(Number(bData.selectedPrice)) && Number(bData.selectedPrice) >= Number(bData.priceMin) && Number(bData.selectedPrice) <= Number(bData.priceMax);
    let finalDisplayTotal = isRangeBooking
        ? (hasValidSelectedPrice ? `${Number(bData.selectedPrice)} جنيه` : `${Number(bData.priceMin)} - ${Number(bData.priceMax)} جنيه`)
        : `${Number(bData.totalAmount ?? bData.price ?? 0) + Number(bData.shippingCost || 0)} جنيه`;
    content.innerHTML = `
        <h1 class="text-center" style="font-size: 2.2rem; color: var(--primary-dark); text-align:center;">${bData.bookingNumber}</h1>
        <p><strong>اسم العميل:</strong> ${bData.customerName}</p>
        <p><strong>رقم الهاتف:</strong> ${bData.customerPhone}</p>
        <p><strong>النوع:</strong> ${bData.type}</p>
        <p><strong>التفاصيل:</strong> ${bData.itemName}</p>
        ${bData.type === 'حجز منتجات' ? `
            <p><strong>الكمية المحجوزة:</strong> ${bData.quantity || 1}</p>
            <p><strong>طريقة الاستلام:</strong> ${bData.deliveryTypeName || 'استلام من الصالون'}</p>
            <p><strong>العنوان:</strong> ${bData.address || '-'}</p>
            <p><strong>سعر المنتجات:</strong> ${bData.price} جنيه</p>
            <p><strong>تكلفة الشحن:</strong> ${bData.shippingCost || 0} جنيه</p>
        ` : ''}
        <p><strong>${isRangeBooking && !hasValidSelectedPrice ? 'نطاق السعر:' : 'الإجمالي الكلي:'}</strong> <span style="color:#c0392b; font-weight:bold; font-size:1.1rem;">${finalDisplayTotal}</span></p>
        ${isRangeBooking && !hasValidSelectedPrice ? `<p class="text-muted">السعر النهائي يحدده مسؤول الفرع/نوسا بين ${bData.priceMin} و ${bData.priceMax} جنيه قبل إصدار الفاتورة.</p>` : ''}
        <p><strong>طريقة الدفع:</strong> ${bData.paymentMethod === 'cash' ? 'نقدي (كاش)' : 'فودافون كاش'}</p>
        <p><strong>الحالة:</strong> ${bData.paymentStatus}</p>
    `;
    document.getElementById('ticket-modal').classList.remove('hidden');
}

function canViewPrices() {
    // الأسعار المالية التفصيلية متاحة لـ Master Admin (نوسا) ومسؤول العروض والمنتجات.
    return userRole === 'nosa' || userRole === 'admin';
}

function renderDashboard() {
    switchView('dashboard-view');
    const roleBadge = document.getElementById('user-role-badge');
    const menu = document.getElementById('sidebar-menu-items');
    if(!menu) return;
    menu.innerHTML = '';

    if (userRole === 'nosa') {
        if(roleBadge) roleBadge.innerText = 'Master Admin (نوسا)';
        menu.innerHTML = `
            <li><a href="javascript:void(0);" onclick="loadNosaOverview()"><i class="fa-solid fa-chart-pie"></i> اللوحة المالية والفواتير والأرشيف</a></li>
            <li><a href="javascript:void(0);" onclick="loadAdminOffersSection()"><i class="fa-solid fa-tags"></i> إدارة الخدمات والمنتجات والأسعار</a></li>
            <li><a href="javascript:void(0);" onclick="loadAdminPaymentsSection()"><i class="fa-solid fa-check-circle"></i> مراجعة فودافون كاش</a></li>
            <li><a href="javascript:void(0);" onclick="loadAdminShippingSection()"><i class="fa-solid fa-truck"></i> إدارة أسعار الشحن والتوصيل</a></li>
            <li><a href="javascript:void(0);" onclick="loadNosaCommunicationsCenter()"><i class="fa-solid fa-headset"></i> شكاوى العملاء والاستفسارات والآراء</a></li>
            <li><a href="javascript:void(0);" onclick="loadNosaAccountSecurity()"><i class="fa-solid fa-key"></i> إدارة كلمات مرور الحسابات</a></li>
        `;
        loadNosaOverview();
    } else if (userRole === 'admin') {
        if(roleBadge) roleBadge.innerText = 'مسؤول العروض والمنتجات';
        menu.innerHTML = `
            <li><a href="javascript:void(0);" onclick="loadAdminOffersSection()"><i class="fa-solid fa-tags"></i> إدارة العروض والخدمات والمنتجات</a></li>
            <li><a href="javascript:void(0);" onclick="loadAdminWalletsSection()"><i class="fa-solid fa-wallet"></i> أرقام فودافون كاش</a></li>
            <li><a href="javascript:void(0);" onclick="loadAdminShippingSection()"><i class="fa-solid fa-truck"></i> إدارة أسعار الشحن والتوصيل</a></li>
            <li><a href="javascript:void(0);" onclick="loadAdminPaymentsSection()"><i class="fa-solid fa-check-circle"></i> مراجعة فودافون كاش</a></li>
            <li><a href="javascript:void(0);" onclick="loadNosaCommunicationsCenter()"><i class="fa-solid fa-headset"></i> شكاوى العملاء والاستفسارات والآراء</a></li>
        `;
        loadAdminOffersSection();
    } else if (userRole === 'dokki' || userRole === 'haddayek') {
        const branchTitle = userRole === 'dokki' ? 'إدارة فرع الدواجن' : 'إدارة فرع الحدائق';
        if(roleBadge) roleBadge.innerText = branchTitle;
        menu.innerHTML = `
            <li><a href="javascript:void(0);" onclick="loadBranchOffersView('${userRole}')"><i class="fa-solid fa-store"></i> متابعة العروض والحجوزات والنقدية</a></li>
            <li><a href="javascript:void(0);" onclick="loadAdminShippingSection()"><i class="fa-solid fa-truck"></i> تعديل أسعار الشحن للفرع</a></li>
        `;
        loadBranchOffersView(userRole);
    }
}

function loadBranchOffersView(branchId) {
    const area = document.getElementById('dynamic-content-area');
    if (!area) return;
    
    const bName = branchId === 'dokki' ? 'فرع الدواجن' : 'فرع الحدائق';
    const branchBookings = appData.bookings.filter(b => b.branchId === branchId);
    const branchServices = appData.services.filter(s => s.branchId === branchId);
    const branchProducts = appData.products.filter(p => p.branchId === branchId);

    let activePrefixes = new Set();
    branchServices.forEach(s => activePrefixes.add(s.codePrefix ? s.codePrefix.trim().toUpperCase() : 'NOSA'));
    branchProducts.forEach(p => activePrefixes.add(p.codePrefix ? p.codePrefix.trim().toUpperCase() : 'NOSA'));
    branchBookings.forEach(b => {
        let pCode = b.codePrefix || (b.bookingNumber.includes('-') ? b.bookingNumber.split('-')[0] : 'NOSA');
        activePrefixes.add(pCode.toUpperCase());
    });

    if (!appData.branchPrefixIndices) appData.branchPrefixIndices = { dokki: {}, haddayek: {} };
    if (!appData.branchPrefixIndices[branchId]) appData.branchPrefixIndices[branchId] = {};

    let prefixPanelsHtml = `<div style="display: flex; flex-wrap: wrap; gap: 15px; margin-bottom: 20px;">`;
    
    activePrefixes.forEach(pCode => {
        let bookingsForThisPrefix = branchBookings.filter(b => b.codePrefix === pCode || b.bookingNumber.startsWith(pCode));
        if (appData.branchPrefixIndices[branchId][pCode] === undefined) {
            appData.branchPrefixIndices[branchId][pCode] = 0;
        }
        let curIdx = appData.branchPrefixIndices[branchId][pCode];
        let currentCodeOnChair = (bookingsForThisPrefix.length > 0 && bookingsForThisPrefix[curIdx]) ? bookingsForThisPrefix[curIdx].bookingNumber : 'لا يوجد حجوزات نشطة';

        prefixPanelsHtml += `
            <div class="card" style="flex: 1; min-width: 250px; background: #fff; border: 2px solid var(--primary-dark); text-align: center; padding: 15px; margin-top:0;">
                <h4 style="color: var(--primary-dark); margin-bottom: 8px;"><i class="fa-solid fa-tag"></i> كود: ${pCode}</h4>
                <p style="font-size: 1rem; margin-bottom: 10px;">
                    الحالي على الكرسي: <br><span style="color: #c0392b; font-size: 1.4rem; font-weight: bold; background: #f8f9fa; padding: 2px 10px; border-radius: 6px; border: 1px solid #ddd; display:inline-block; margin-top:5px;">${currentCodeOnChair}</span>
                </p>
                <button class="btn btn-primary btn-sm" style="font-size: 0.95rem; padding: 8px 15px; width: 100%;" onclick="nextPrefixQueue('${branchId}', '${pCode}')">
                    <i class="fa-solid fa-forward"></i> التالي (${pCode})
                </button>
            </div>
        `;
    });

    prefixPanelsHtml += `</div>`;

    let html = `
        <h2>متابعة العروض وحجوزات ${bName}</h2>

        <h3 class="mt-3" style="color: #333;"><i class="fa-solid fa-chair"></i> لوحة التحكم في الكرسي حسب الأكواد (التالي لكل كود):</h3>
        ${prefixPanelsHtml}

        <div class="card mt-3">
            <h3>الخدمات والمنتجات المتاحة حالياً في الفرع والكميات (مع إمكانية تصفير عداد الحجز)</h3>
            <div class="table-responsive mt-2">
                <table>
                    <thead>
                        <tr><th>النوع</th><th>الاسم</th><th>الكمية المتاحة وتم الحجز</th><th>البادئة</th><th>تصفير العداد</th></tr>
                    </thead>
                    <tbody>
    `;

    if (branchServices.length > 0 || branchProducts.length > 0) {
        branchServices.forEach(s => {
            html += `<tr>
                <td><span class="badge" style="background:#2980b9; color:#fff;">خدمة</span></td>
                <td>${s.name}</td>
                <td><strong>المتبقي:</strong> ${s.max} | <strong>تم حجز:</strong> ${s.currentCount || 0}</td>
                <td><span class="badge" style="background:#34495e; color:#fff;">${s.codePrefix || 'NOSA'}</span></td>
                <td><button class="btn btn-danger btn-sm" onclick="resetItemCount('${s.id}', 'service')"><i class="fa-solid fa-rotate-left"></i> تصفير عداد الحجز</button></td>
            </tr>`;
        });
        branchProducts.forEach(p => {
            html += `<tr>
                <td><span class="badge" style="background:#8e44ad; color:#fff;">منتج</span></td>
                <td>${p.name}</td>
                <td><strong>المتبقي بالمخزن:</strong> ${p.qty} | <strong>تم حجز:</strong> ${p.currentCount || 0}</td>
                <td><span class="badge" style="background:#34495e; color:#fff;">${p.codePrefix || 'NOSA'}</span></td>
                <td><button class="btn btn-danger btn-sm" onclick="resetItemCount('${p.id}', 'product')"><i class="fa-solid fa-rotate-left"></i> تصفير عداد الحجز</button></td>
            </tr>`;
        });
    } else {
        html += `<tr><td colspan="5">لا توجد خدمات أو منتجات مضافة لهذا الفرع بعد.</td></tr>`;
    }

    html += `
                    </tbody>
                </table>
            </div>
        </div>

        <div class="card mt-4">
            <h3>حجوزات العملاء الكاملة</h3>
    `;
    
    if(branchBookings.length > 0) {
        html += `
            <div class="table-responsive mt-2">
                <table>
                    <thead>
                        <tr>
                            <th>العميل والهاتف</th>
                            <th>كود الحجز</th>
                            <th>التفاصيل والكمية</th>
                            <th>الاستلام والعنوان</th>
                            <th>الدفع</th>
                            <th>حالة الطلب / التجهيز</th>
                            <th>الإجراء</th>
                        </tr>
                    </thead>
                    <tbody>
        `;
        branchBookings.forEach(b => {
            let actionBtn = '';
            let isAlreadyInvoiced = appData.invoices && appData.invoices.some(inv => inv.bookingNumber === b.bookingNumber);

            let statusControlHtml = '';
            if (b.type === 'حجز منتجات') {
                let currentStatus = b.orderStatus || 'يتم تجهيز الأوردر';
                statusControlHtml = `
                    <div style="display:flex; flex-direction:column; gap:5px; min-width:140px;">
                        <select id="status-sel-${b.id}" class="form-control" style="padding:4px; font-size:0.85rem;">
                            <option value="يتم تجهيز الأوردر" ${currentStatus === 'يتم تجهيز الأوردر' ? 'selected' : ''}>يتم تجهيز الأوردر</option>
                            <option value="تم التجهيز" ${currentStatus === 'تم التجهيز' ? 'selected' : ''}>تم التجهيز</option>
                            <option value="تم الشحن" ${currentStatus === 'تم الشحن' ? 'selected' : ''}>تم الشحن</option>
                            <option value="جاهز للتسليم" ${currentStatus === 'جاهز للتسليم' ? 'selected' : ''}>جاهز للتسليم</option>
                            <option value="تم الاستلام" ${currentStatus === 'تم الاستلام' ? 'selected' : ''}>تم الاستلام</option>
                        </select>
                        <button class="btn btn-sm btn-secondary" style="font-size:0.75rem; padding:3px;" onclick="updateProductOrderStatus('${b.id}')">تحديث الحالة</button>
                    </div>
                `;
            } else {
                statusControlHtml = `<span class="badge" style="background:#27ae60; color:#fff;">خدمة داخل الصالون</span>`;
            }

            if (b.paymentMethod === 'cash') {
                if (b.paymentStatus === 'جاري المراجعة' && !isAlreadyInvoiced) {
                    const priceBtn = (b.type === 'حجز خدمة' && b.priceMode === 'range') ? `<button class="btn btn-secondary btn-sm" onclick="setBookingActualPrice('${b.id}', 'branch')">تحديد السعر الفعلي (${getBookingPriceLabel(b)})</button>` : '';
                    actionBtn = `<div style="display:flex; flex-direction:column; gap:5px;">${priceBtn}<button class="btn btn-primary btn-sm" onclick="confirmBranchCashPayment('${b.id}')">تأكيد الكاش وإصدار الفاتورة</button><br>${statusControlHtml}</div>`;
                } else {
                    actionBtn = `<div style="display:flex; flex-direction:column; gap:5px;"><button class="btn btn-danger btn-sm" onclick="deleteBranchBooking('${b.id}')">حذف الحجز</button><br>${statusControlHtml}</div>`;
                }
            } else {
                actionBtn = `<div style="display:flex; flex-direction:column; gap:5px;"><span class="badge">${b.paymentStatus}</span><br>${statusControlHtml}</div>`;
            }

            let detailsCol = `${b.itemName} ${b.type === 'حجز منتجات' ? `<br><span class="badge" style="background:#e67e22; color:#fff;">${b.quantity || 1} قطعة</span>` : `<br><strong style="color:#c0392b;">السعر: ${getBookingPriceLabel(b)}</strong>`}`;
            let deliveryCol = b.type === 'حجز منتجات' ? `<strong>${b.deliveryTypeName}</strong><br><small style="color:#666;">العنوان: ${b.address}</small>` : `-`;

            html += `<tr>
                <td>${b.customerName}<br><small>${b.customerPhone}</small></td>
                <td><strong>${b.bookingNumber}</strong></td>
                <td>${detailsCol}</td>
                <td>${deliveryCol}</td>
                <td>${b.paymentMethod === 'cash' ? 'كاش' : 'فودافون كاش'}</td>
                <td><span class="badge" style="background:#16a085; color:#fff;">${b.orderStatus || (b.type === 'حجز منتجات' ? 'يتم تجهيز الأوردر' : 'داخل الصالون')}</span></td>
                <td>${actionBtn}</td>
            </tr>`;
        });
        html += `</tbody></table></div>`;
    } else {
        html += `<p class="mt-2 text-muted">لا توجد حجوزات حالياً.</p>`;
    }
    html += `</div>`;
    area.innerHTML = html;
}

function updateProductOrderStatus(bookingId) {
    const selectEl = document.getElementById(`status-sel-${bookingId}`);
    if (!selectEl) return;
    const newStatus = selectEl.value;

    const booking = appData.bookings.find(b => b.id === bookingId);
    if (booking) {
        booking.orderStatus = newStatus;
        saveData();
        alert(`تم تحديث حالة الأوردر إلى: "${newStatus}" بنجاح!`);
        let currentActiveBranch = currentUser.email.includes('dokki') ? 'dokki' : (currentUser.email.includes('haddayek') ? 'haddayek' : booking.branchId);
        loadBranchOffersView(currentActiveBranch);
    }
}

function resetItemCount(itemId, type) {
    if (confirm('هل أنت متأكد من تصفير عداد "تم الحجز" وحذف حجوزات هذا البند نهائياً لتبدأ من الصفر؟')) {
        let targetItem = null;
        let pCode = '';

        if (type === 'service') {
            targetItem = appData.services.find(s => s.id === itemId);
        } else {
            targetItem = appData.products.find(p => p.id === itemId);
        }

        if (targetItem) {
            pCode = (targetItem.codePrefix || 'NOSA').trim().toUpperCase();
            
            targetItem.currentCount = 0;

            appData.bookings = appData.bookings.filter(b => {
                let matchesId = (b.itemId === itemId);
                let matchesPrefix = (b.codePrefix === pCode || b.bookingNumber.startsWith(pCode + '-'));
                return !(matchesId || matchesPrefix);
            });

            if (appData.branchPrefixIndices) {
                for (let branchId in appData.branchPrefixIndices) {
                    if (appData.branchPrefixIndices[branchId][pCode] !== undefined) {
                        appData.branchPrefixIndices[branchId][pCode] = 0;
                    }
                }
            }

            saveData();
            alert('تم تصفير العداد وحذف الحجوزات القديمة بنجاح!');
            
            const activeBranch = currentUser.email.includes('dokki') ? 'dokki' : (currentUser.email.includes('haddayek') ? 'haddayek' : null);
            if (activeBranch) {
                loadBranchOffersView(activeBranch);
            } else {
                location.reload();
            }
        }
    }
}

function nextPrefixQueue(branchId, pCode) {
    const branchBookings = appData.bookings.filter(b => b.branchId === branchId && (b.codePrefix === pCode || b.bookingNumber.startsWith(pCode)));
    if (branchBookings.length === 0) {
        alert(`لا توجد حجوزات نشطة تحت الكود (${pCode}) حالياً!`);
        return;
    }
    
    if (!appData.branchPrefixIndices) appData.branchPrefixIndices = { dokki: {}, haddayek: {} };
    if (!appData.branchPrefixIndices[branchId]) appData.branchPrefixIndices[branchId] = {};
    if (appData.branchPrefixIndices[branchId][pCode] === undefined) {
        appData.branchPrefixIndices[branchId][pCode] = 0;
    }

    if (appData.branchPrefixIndices[branchId][pCode] < branchBookings.length - 1) {
        appData.branchPrefixIndices[branchId][pCode] += 1;
        saveData();
        alert(`تم الانتقال للعميل التالي في الكود (${pCode}) بنجاح!`);
        loadBranchOffersView(branchId);
    } else {
        alert(`هذا هو آخر عميل في طابور الكود (${pCode}) حالياً!`);
    }
}

function confirmBranchCashPayment(bookingId) {
    const booking = appData.bookings.find(b => b.id === bookingId);
    if (booking) {
        if (booking.type === 'حجز خدمة' && booking.priceMode === 'range' && !Number.isFinite(Number(booking.selectedPrice))) {
            setBookingActualPrice(bookingId, 'branch');
            if (!Number.isFinite(Number(booking.selectedPrice))) return;
        }
        booking.paymentStatus = 'تم استلام المبلغ';
        if (!appData.invoices) appData.invoices = [];
        
        const exists = appData.invoices.some(inv => inv.bookingNumber === booking.bookingNumber);
        if (!exists) {
            let itemDesc = (booking.type === 'حجز منتجات') ? `${booking.itemName} (الكمية: ${booking.quantity || 1} - شحن: ${booking.deliveryTypeName})` : `${booking.itemName}`;
            let finalInvPrice = booking.totalAmount || (booking.price + (booking.shippingCost || 0));
            appData.invoices.push({
                invoiceId: 'INV-' + Math.floor(100000 + Math.random() * 900000),
                bookingNumber: booking.bookingNumber,
                customerName: booking.customerName,
                customerPhone: booking.customerPhone,
                branchId: booking.branchId.trim().toLowerCase(),
                itemName: itemDesc,
                price: finalInvPrice,
                paymentMethod: 'نقدي (كاش)',
                date: new Date().toLocaleDateString('ar-EG')
            });
        }
        
        let todayStr = new Date().toLocaleDateString('ar-EG');
        if (appData.closedDays) {
            appData.closedDays = appData.closedDays.filter(d => !(d.branchId === booking.branchId && d.date === todayStr));
        }

        saveData();
        alert('تم تأكيد الحجز وإصدار الفاتورة وسماعها في إيرادات نوسا وكل الحسابات بنجاح!');
        let currentActiveBranch = currentUser.email.includes('dokki') ? 'dokki' : (currentUser.email.includes('haddayek') ? 'haddayek' : booking.branchId);
        loadBranchOffersView(currentActiveBranch);
    }
}

function deleteBranchBooking(bookingId) {
    if (confirm('هل تريد حذف هذا الحجز نهائياً؟')) {
        appData.bookings = appData.bookings.filter(b => b.id !== bookingId);
        saveData();
        let currentActiveBranch = currentUser.email.includes('dokki') ? 'dokki' : (currentUser.email.includes('haddayek') ? 'haddayek' : 'dokki');
        loadBranchOffersView(currentActiveBranch);
    }
}

function getItemPriceMode(item) {
    return item && item.priceMode === 'range' ? 'range' : 'single';
}
function getItemPriceMin(item) {
    const min = Number(item?.priceMin);
    return Number.isFinite(min) ? min : Number(item?.price || 0);
}
function getItemPriceMax(item) {
    const max = Number(item?.priceMax);
    return Number.isFinite(max) ? max : Number(item?.price || 0);
}
function getItemPriceLabel(item) {
    if (!item) return '0 جنيه';
    const min = getItemPriceMin(item), max = getItemPriceMax(item);
    if (getItemPriceMode(item) === 'range' && max > min) return `${min} - ${max} جنيه`;
    return `${Number(item.price ?? min)} جنيه`;
}
function getItemCalculationPrice(item) {
    return getItemPriceMode(item) === 'range' ? getItemPriceMin(item) : Number(item?.price || 0);
}

function getBookingPriceLabel(booking) {
    if (!booking) return '0 جنيه';
    if (booking.type === 'حجز خدمة' && booking.priceMode === 'range' && Number(booking.priceMax) > Number(booking.priceMin)) {
        if (Number.isFinite(Number(booking.selectedPrice)) && Number(booking.selectedPrice) >= Number(booking.priceMin) && Number(booking.selectedPrice) <= Number(booking.priceMax)) {
            return `${Number(booking.selectedPrice)} جنيه`;
        }
        return `${Number(booking.priceMin)} - ${Number(booking.priceMax)} جنيه`;
    }
    return `${Number(booking.totalAmount ?? booking.price ?? 0) + Number(booking.shippingCost || 0)} جنيه`;
}

function setBookingActualPrice(bookingId, returnView) {
    const booking = appData.bookings.find(b => b.id === bookingId);
    if (!booking || booking.type !== 'حجز خدمة' || booking.priceMode !== 'range') return false;
    const min = Number(booking.priceMin), max = Number(booking.priceMax);
    const current = Number.isFinite(Number(booking.selectedPrice)) ? Number(booking.selectedPrice) : min;
    const input = prompt(`حدد السعر الفعلي الذي سيدفعه العميل\nالمسموح من ${min} إلى ${max} جنيه:`, String(current));
    if (input === null) return false;
    const value = parseFloat(input);
    if (!Number.isFinite(value) || value < min || value > max) {
        alert(`السعر يجب أن يكون بين ${min} و ${max} جنيه.`);
        return false;
    }
    booking.selectedPrice = value;
    booking.price = value;
    booking.totalAmount = value;
    saveData();

    // لا ننقل مسؤول العروض والمنتجات إلى صفحة الفروع عند تعديل سعر حجز من مراجعة فودافون كاش.
    if (returnView === 'payments') {
        if (typeof renderAdminPaymentsTable === 'function') { try { renderAdminPaymentsTable(); } catch (_) {} }
    } else if (returnView === 'branch') {
        if (typeof loadBranchOffersView === 'function' && booking.branchId) {
            try { loadBranchOffersView(booking.branchId); } catch (_) {}
        }
    } else if (userRole === 'admin' && typeof renderAdminPaymentsTable === 'function') {
        try { renderAdminPaymentsTable(); } catch (_) {}
    }
    alert(`تم تحديد سعر الحجز: ${value} جنيه. سيظهر بهذا السعر في الفاتورة وإيرادات نوسا.`);
    return true;
}

function loadAdminOffersSection() {
    const area = document.getElementById('dynamic-content-area');
    if (!area) return;
    area.innerHTML = `
        <h2>إدارة عروض الخدمات والمنتجات</h2>
        <div class="card mt-3">
            <div class="admin-edit-note"><strong>مهم:</strong> أضف كل خدمة أو منتج مرة واحدة فقط. يظهر السعر لمسؤول العروض والمنتجات وMaster Admin، ويمكن تعديل السعر أو مدى السعر أو البادئة أو العدد المتاح من زر <strong>تعديل</strong> بدون حذف العنصر. <strong>اسم الخدمة/المنتج لا يتم تغييره من زر التعديل.</strong></div>
            <form id="admin-add-service-form">
                <div class="form-row">
                    <div class="form-group"><label>الفرع</label><select id="adm-branch" required><option value="dokki">فرع الدواجن</option><option value="haddayek">فرع الحدائق</option></select></div>
                    <div class="form-group"><label>النوع</label><select id="adm-type" required><option value="service">خدمة</option><option value="product">منتج</option></select></div>
                </div>
                <div class="form-row">
                    <div class="form-group"><label>الاسم</label><input type="text" id="adm-name" required placeholder="اسم الخدمة أو المنتج"></div>
                    <div class="form-group"><label>نوع السعر</label><select id="adm-price-mode" required><option value="single">سعر ثابت</option><option value="range">مدى سعري (من - إلى)</option></select></div>
                </div>
                <div class="form-row">
                    <div class="form-group"><label id="adm-price-label">السعر للقطعة</label><input type="number" id="adm-price" min="0" step="0.01" required placeholder="مثال: 100"></div>
                    <div class="form-group hidden" id="adm-price-max-group"><label>السعر إلى</label><input type="number" id="adm-price-max" min="0" step="0.01" placeholder="مثال: 500"></div>
                </div>
                <div class="form-row">
                    <div class="form-group"><label>العدد الإجمالي المتاح / المخزون</label><input type="number" id="adm-max" min="0" required placeholder="مثال: 15"></div>
                    <div class="form-group"><label>بادئة كود التسلسل (مثال: AMANY, DODO, NOSA)</label><input type="text" id="adm-prefix" required placeholder="اسم الكود بالإنجليزية"></div>
                </div>
                <button type="submit" class="btn btn-primary">إضافة الخدمة/المنتج</button>
            </form>
        </div>
        <div class="card mt-4"><div id="admin-services-list"></div></div>`;

    const modeEl=document.getElementById('adm-price-mode'), maxGroup=document.getElementById('adm-price-max-group'), maxInput=document.getElementById('adm-price-max'), label=document.getElementById('adm-price-label');
    const toggle=()=>{const range=modeEl?.value==='range';maxGroup?.classList.toggle('hidden',!range);if(maxInput)maxInput.required=range;if(label)label.textContent=range?'السعر من':'السعر للقطعة';};
    modeEl?.addEventListener('change',toggle); toggle(); renderAdminServicesTable();

    const form=document.getElementById('admin-add-service-form');
    if(form) form.onsubmit=function(e){
        e.preventDefault();
        const mode=modeEl.value, min=parseFloat(document.getElementById('adm-price').value), max=mode==='range'?parseFloat(maxInput.value):min, available=parseInt(document.getElementById('adm-max').value);
        if(!Number.isFinite(min)||!Number.isFinite(max)||min<0||max<min){alert('يرجى إدخال سعر صحيح. في المدى السعري يجب أن يكون السعر إلى أكبر من أو يساوي السعر من.');return;}
        const item={id:'ITM-'+Date.now(),branchId:document.getElementById('adm-branch').value,name:document.getElementById('adm-name').value.trim(),price:min,priceMin:min,priceMax:max,priceMode:mode,max:available,qty:available,currentCount:0,codePrefix:document.getElementById('adm-prefix').value.trim().toUpperCase()};
        if(document.getElementById('adm-type').value==='service') appData.services.push(item); else appData.products.push(item);
        saveData();e.target.reset();toggle();renderAdminServicesTable();alert('تمت الإضافة بنجاح. يمكنك الآن تعديل السعر أو الكود أو المخزون من زر تعديل بدون حذف العنصر.');
    };
}

function renderAdminServicesTable() {
    const listDiv=document.getElementById('admin-services-list'); if(!listDiv)return;
    const priceHead=canViewPrices()?'<th>السعر</th>':'';
    let html=`<table><thead><tr><th>النوع</th><th>الفرع</th><th>الاسم</th>${priceHead}<th>العدد/المتبقي</th><th>البادئة (الكود)</th><th>إجراء</th></tr></thead><tbody>`;
    appData.services.forEach(s=>{const pc=canViewPrices()?`<td>${getItemPriceLabel(s)}</td>`:'';html+=`<tr><td>خدمة</td><td>${s.branchId==='dokki'?'الدواجن':'الحدائق'}</td><td>${s.name}</td>${pc}<td>${s.max}</td><td><span class="badge" style="background:#34495e;color:#fff;">${s.codePrefix||'NOSA'}</span></td><td class="admin-item-actions"><button class="btn btn-primary btn-sm" onclick="editItem('${s.id}','service')">تعديل</button> <button class="btn btn-danger btn-sm" onclick="deleteItem('${s.id}','service')">حذف</button></td></tr>`;});
    appData.products.forEach(p=>{const pc=canViewPrices()?`<td>${getItemPriceLabel(p)}</td>`:'';html+=`<tr><td>منتج</td><td>${p.branchId==='dokki'?'الدواجن':'الحدائق'}</td><td>${p.name}</td>${pc}<td>${p.qty}</td><td><span class="badge" style="background:#34495e;color:#fff;">${p.codePrefix||'NOSA'}</span></td><td class="admin-item-actions"><button class="btn btn-primary btn-sm" onclick="editItem('${p.id}','product')">تعديل</button> <button class="btn btn-danger btn-sm" onclick="deleteItem('${p.id}','product')">حذف</button></td></tr>`;});
    listDiv.innerHTML=html+'</tbody></table>';
}

function editItem(id,type){
    const collection=type==='service'?appData.services:appData.products,item=collection.find(x=>x.id===id);if(!item)return;
    const mode=getItemPriceMode(item), min=getItemPriceMin(item), max=getItemPriceMax(item), available=type==='service'?Number(item.max||0):Number(item.qty||0);
    // اسم الخدمة/المنتج ثابت ولا يتم تعديله من هنا. التعديل مخصص للسعر والكود والمخزون فقط.
    const modeInput=prompt('نوع السعر: اكتب single للسعر الثابت أو range للمدى السعري.',mode);if(modeInput===null)return;
    const newMode=modeInput.trim().toLowerCase()==='range'?'range':'single';
    const minInput=prompt(newMode==='range'?'السعر من:':'السعر للقطعة:',String(min));if(minInput===null)return;const newMin=parseFloat(minInput);
    let newMax=newMin;if(newMode==='range'){const maxInput=prompt('السعر إلى:',String(max));if(maxInput===null)return;newMax=parseFloat(maxInput);}
    const availInput=prompt('العدد الإجمالي المتاح / المخزون:',String(available));if(availInput===null)return;const newAvailable=parseInt(availInput);
    const prefix=prompt('بادئة الكود:',item.codePrefix||'NOSA');if(prefix===null)return;
    if(!Number.isFinite(newMin)||!Number.isFinite(newMax)||newMin<0||newMax<newMin||!Number.isInteger(newAvailable)||newAvailable<0||!prefix.trim()){alert('البيانات المدخلة غير صحيحة. راجع السعر والعدد والبادئة.');return;}
    item.priceMode=newMode;item.priceMin=newMin;item.priceMax=newMax;item.price=newMin;item.codePrefix=prefix.trim().toUpperCase();
    if(type==='service') item.max=newAvailable; else {item.qty=newAvailable;item.max=newAvailable;}
    saveData();renderAdminServicesTable();alert('تم تعديل العنصر بنجاح بدون حذفه أو إنشاء عنصر جديد.');
}

function deleteItem(id,type){if(type==='service')appData.services=appData.services.filter(s=>s.id!==id);else appData.products=appData.products.filter(p=>p.id!==id);saveData();renderAdminServicesTable();}

function loadAdminShippingSection() {
    const area = document.getElementById('dynamic-content-area');
    if (!area) return;

    if (!appData.shippingRates) {
        appData.shippingRates = {
            dokki: { pickup: 0, local: 30, regional: 60 },
            haddayek: { pickup: 0, local: 30, regional: 60 }
        };
    }

    area.innerHTML = `
        <h2>إدارة أسعار الشحن والتوصيل</h2>
        <p class="text-muted mt-1">تحديد تكلفة الشحن لكل فرع سواء استلام من الصالون، توصيل داخل القاهرة، أو شحن محافظات.</p>
        
        <div class="card mt-3">
            <h3>أسعار شحن فرع الدواجن</h3>
            <form id="shipping-dokki-form" class="mt-2">
                <div class="form-row">
                    <div class="form-group">
                        <label>استلام من الصالون</label>
                        <input type="number" id="dokki-pickup" value="${appData.shippingRates.dokki.pickup}" required>
                    </div>
                    <div class="form-group">
                        <label>توصيل داخل القاهرة</label>
                        <input type="number" id="dokki-local" value="${appData.shippingRates.dokki.local}" required>
                    </div>
                    <div class="form-group">
                        <label>شحن محافظات</label>
                        <input type="number" id="dokki-regional" value="${appData.shippingRates.dokki.regional}" required>
                    </div>
                </div>
                <button type="submit" class="btn btn-primary">حفظ أسعار شحن الدواجن</button>
            </form>
        </div>

        <div class="card mt-4">
            <h3>أسعار شحن فرع الحدائق</h3>
            <form id="shipping-haddayek-form" class="mt-2">
                <div class="form-row">
                    <div class="form-group">
                        <label>استلام من الصالون</label>
                        <input type="number" id="haddayek-pickup" value="${appData.shippingRates.haddayek.pickup}" required>
                    </div>
                    <div class="form-group">
                        <label>توصيل داخل القاهرة</label>
                        <input type="number" id="haddayek-local" value="${appData.shippingRates.haddayek.local}" required>
                    </div>
                    <div class="form-group">
                        <label>شحن محافظات</label>
                        <input type="number" id="haddayek-regional" value="${appData.shippingRates.haddayek.regional}" required>
                    </div>
                </div>
                <button type="submit" class="btn btn-primary">حفظ أسعار شحن الحدائق</button>
            </form>
        </div>
    `;

    document.getElementById('shipping-dokki-form').onsubmit = function(e) {
        e.preventDefault();
        appData.shippingRates.dokki.pickup = parseFloat(document.getElementById('dokki-pickup').value) || 0;
        appData.shippingRates.dokki.local = parseFloat(document.getElementById('dokki-local').value) || 0;
        appData.shippingRates.dokki.regional = parseFloat(document.getElementById('dokki-regional').value) || 0;
        saveData();
        alert('تم حفظ أسعار شحن فرع الدواجن بنجاح!');
    };

    document.getElementById('shipping-haddayek-form').onsubmit = function(e) {
        e.preventDefault();
        appData.shippingRates.haddayek.pickup = parseFloat(document.getElementById('haddayek-pickup').value) || 0;
        appData.shippingRates.haddayek.local = parseFloat(document.getElementById('haddayek-local').value) || 0;
        appData.shippingRates.haddayek.regional = parseFloat(document.getElementById('haddayek-regional').value) || 0;
        saveData();
        alert('تم حفظ أسعار شحن فرع الحدائق بنجاح!');
    };
}

function loadAdminWalletsSection() {
    const area = document.getElementById('dynamic-content-area');
    if (!area) return;
    area.innerHTML = `
        <h2>إدارة محافظ فودافون كاش</h2>
        <div class="card mt-3">
            <form id="admin-wallet-form">
                <div class="form-group">
                    <label>الفرع</label>
                    <select id="w-branch">
                        <option value="dokki">الدواجن</option>
                        <option value="haddayek">الحدائق</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>اسم المحفظة</label>
                    <input type="text" id="w-name" required placeholder="مثال: فودافون كاش فرع الحدائق">
                </div>
                <div class="form-group">
                    <label>الرقم</label>
                    <input type="text" id="w-number" required placeholder="01xxxxxxxx0">
                </div>
                <button type="submit" class="btn btn-primary">إضافة المحفظة</button>
            </form>
        </div>
        <div class="card mt-4">
            <h3>المحافظ المسجلة حالياً</h3>
            <div id="wallets-admin-list" class="mt-2"></div>
        </div>
    `;
    renderWalletsList();

    const walletForm = document.getElementById('admin-wallet-form');
    if(walletForm) {
        walletForm.onsubmit = function(e) {
            e.preventDefault();
            const branchId = document.getElementById('w-branch').value;
            const name = document.getElementById('w-name').value;
            const number = document.getElementById('w-number').value;
            
            appData.wallets.push({ 
                id: 'W-' + Date.now(), 
                branchId, 
                name, 
                number 
            });
            
            saveData();
            walletForm.reset();
            renderWalletsList();
            alert('تم إضافة رقم المحفظة بنجاح وظهر في صفحة العملاء!');
        };
    }
}

function renderWalletsList() {
    const div = document.getElementById('wallets-admin-list');
    if (!div) return;
    if (appData.wallets.length === 0) {
        div.innerHTML = '<p class="text-muted">لا توجد محافظ مسجلة حالياً.</p>';
        return;
    }
    let html = `<table><thead><tr><th>الفرع</th><th>اسم المحفظة</th><th>الرقم</th><th>الإجراء</th></tr></thead><tbody>`;
    appData.wallets.forEach(w => {
        html += `<tr>
            <td>${w.branchId === 'dokki' ? 'الدواجن' : 'الحدائق'}</td>
            <td>${w.name}</td>
            <td><strong>${w.number}</strong></td>
            <td><button class="btn btn-danger btn-sm" onclick="deleteWallet('${w.id}')">حذف</button></td>
        </tr>`;
    });
    html += `</tbody></table>`;
    div.innerHTML = html;
}

function deleteWallet(walletId) {
    if (confirm('هل أنت متأكد من حذف رقم المحفظة هذا؟')) {
        appData.wallets = appData.wallets.filter(w => w.id !== walletId);
        saveData();
        renderWalletsList();
        alert('تم حذف المحفظة بنجاح.');
    }
}

function loadAdminPaymentsSection() {
    const area = document.getElementById('dynamic-content-area');
    if (!area) return;
    area.innerHTML = `<h2>مراجعة مدفوعات فودافون كاش</h2><div class="card mt-3"><div id="admin-payments-table"></div></div>`;
    renderAdminPaymentsTable();
}

function renderAdminPaymentsTable() {
    const container = document.getElementById('admin-payments-table');
    if (!container) return;
    const walletBookings = appData.bookings.filter(b => b.paymentMethod === 'wallet');
    if (walletBookings.length === 0) {
        container.innerHTML = '<p>لا توجد تحويلات معلقة.</p>';
        return;
    }
    let html = `<table><thead><tr><th>العميل</th><th>الكود</th><th>الفرع</th><th>التفاصيل والاستلام</th><th>الحالة</th><th>الإجراء</th></tr></thead><tbody>`;
    walletBookings.forEach(b => {
        let isAlreadyInvoiced = appData.invoices && appData.invoices.some(inv => inv.bookingNumber === b.bookingNumber);
        let btn = '';
        if (b.paymentStatus === 'جاري المراجعة' && !isAlreadyInvoiced) {
            const priceBtn = (b.type === 'حجز خدمة' && b.priceMode === 'range') ? `<button class="btn btn-secondary btn-sm" onclick="setBookingActualPrice('${b.id}', 'payments')">تحديد السعر: ${getBookingPriceLabel(b)}</button>` : '';
            btn = `${priceBtn}<button class="btn btn-primary btn-sm" onclick="confirmAdminPayment('${b.id}')">تأكيد التحويل</button>`;
        } else {
            btn = `<button class="btn btn-danger btn-sm" onclick="deleteAdminBooking('${b.id}')">حذف</button>`;
        }
        let detailsText = `${b.itemName} ${b.type === 'حجز منتجات' ? `<br><small>(${b.deliveryTypeName}) - ${b.address}</small>` : `<br><strong style="color:#c0392b;">السعر: ${getBookingPriceLabel(b)}</strong>`}`;
        html += `<tr><td>${b.customerName}</td><td><strong>${b.bookingNumber}</strong></td><td>${b.branchId === 'dokki' ? 'فرع الدواجن' : 'فرع الحدائق'}</td><td>${detailsText}</td><td><span class="badge">${b.paymentStatus}</span></td><td>${btn}</td></tr>`;
    });
    html += `</tbody></table>`;
    container.innerHTML = html;
}

function confirmAdminPayment(bookingId) {
    const b = appData.bookings.find(item => item.id === bookingId);
    if (b) {
        if (b.type === 'حجز خدمة' && b.priceMode === 'range' && !Number.isFinite(Number(b.selectedPrice))) {
            setBookingActualPrice(bookingId, 'payments');
            if (!Number.isFinite(Number(b.selectedPrice))) return;
        }
        b.paymentStatus = 'تم استلام المبلغ';
        if (!appData.invoices) appData.invoices = [];
        
        const exists = appData.invoices.some(inv => inv.bookingNumber === b.bookingNumber);
        if (!exists) {
            let itemDesc = (b.type === 'حجز منتجات') ? `${b.itemName} (الكمية: ${b.quantity || 1} - شحن: ${b.deliveryTypeName})` : `${b.itemName}`;
            let finalInvPrice = b.totalAmount || (b.price + (b.shippingCost || 0));
            appData.invoices.push({
                invoiceId: 'INV-' + Math.floor(100000 + Math.random() * 900000),
                bookingNumber: b.bookingNumber,
                customerName: b.customerName,
                customerPhone: b.customerPhone,
                branchId: b.branchId.trim().toLowerCase(),
                itemName: itemDesc,
                price: finalInvPrice,
                paymentMethod: 'فودافون كاش',
                date: new Date().toLocaleDateString('ar-EG')
            });
        }
        
        let todayStr = new Date().toLocaleDateString('ar-EG');
        if (appData.closedDays) {
            appData.closedDays = appData.closedDays.filter(d => !(d.branchId === b.branchId && d.date === todayStr));
        }

        saveData();
        renderAdminPaymentsTable();
        alert('تم التأكيد وإصدار الفاتورة وسماعها في إيرادات نوسا وكل الحسابات بنجاح!');
    }
}

function deleteAdminBooking(bookingId) {
    if (confirm('حذف الحجز والفاتورة المرتبطة به نهائياً من جميع الحسابات؟')) {
        const booking = appData.bookings.find(b => b.id === bookingId);
        const bookingNumber = booking ? booking.bookingNumber : null;

        // حذف الحجز من البيانات المشتركة، وليس من شاشة الأدمن فقط.
        appData.bookings = appData.bookings.filter(b => b.id !== bookingId);

        // إذا كان قد تم إصدار فاتورة لهذا الحجز، تُحذف أيضاً من الإيرادات والأرشيف.
        if (bookingNumber && Array.isArray(appData.invoices)) {
            appData.invoices = appData.invoices.filter(inv => inv.bookingNumber !== bookingNumber);
        }

        saveData();
        renderAdminPaymentsTable();
        alert('تم حذف الحجز والفاتورة المرتبطة به من جميع الحسابات بنجاح.');
    }
}

function loadNosaOverview() {
    const area = document.getElementById('dynamic-content-area');
    if (!area) return;
    let todayStr = new Date().toLocaleDateString('ar-EG');
    if (!appData.closedDays) appData.closedDays = [];
    
    const dokkiClosedToday = appData.closedDays.some(d => d.branchId === 'dokki' && d.date === todayStr);
    const haddayekClosedToday = appData.closedDays.some(d => d.branchId === 'haddayek' && d.date === todayStr);

    let dokkiInc = 0, haddayekInc = 0;
    if (appData.invoices) {
        appData.invoices.forEach(inv => {
            let invBranch = (inv.branchId || '').trim().toLowerCase();
            if (invBranch === 'dokki' || invBranch.includes('dokki') || invBranch.includes('الدواجن')) {
                dokkiInc += Number(inv.price || 0);
            }
            if (invBranch === 'haddayek' || invBranch.includes('haddayek') || invBranch.includes('الحدائق')) {
                haddayekInc += Number(inv.price || 0);
            }
        });
    }

    area.innerHTML = `
        <h2>اللوحة المالية وأرشيف الفواتير - نوسا (Master Admin)</h2>
        <div class="stats-grid mt-3">
            <div class="stat-card">
                <h4>دخل الدواجن اليوم</h4>
                <div class="value" style="color:#2980b9;">${dokkiInc} جنيه</div>
                <button class="btn btn-danger btn-sm mt-2" onclick="closeBranchDay('dokki')">${dokkiClosedToday ? 'تم التقفيل اليوم' : 'تقفيل يوم الدواجن'}</button>
            </div>
            <div class="stat-card">
                <h4>دخل الحدائق اليوم</h4>
                <div class="value" style="color:#8e44ad;">${haddayekInc} جنيه</div>
                <button class="btn btn-danger btn-sm mt-2" onclick="closeBranchDay('haddayek')">${haddayekClosedToday ? 'تم التقفيل اليوم' : 'تقفيل يوم الحدائق'}</button>
            </div>
            <div class="stat-card"><h4>إجمالي الإيرادات</h4><div class="value" style="color:#27ae60;">${dokkiInc + haddayekInc} جنيه</div></div>
            <div class="stat-card"><h4>عدد الفواتير المعتمدة</h4><div class="value">${appData.invoices ? appData.invoices.length : 0}</div></div>
        </div>
        <div class="card mt-4">
            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
                <h3>أرشيف الفواتير المعتمدة</h3>
                ${(appData.invoices && appData.invoices.length > 0) ? `<button class="btn btn-danger btn-sm" onclick="clearAllNosaInvoices()"><i class="fa-solid fa-trash"></i> تصفير وحذف كل الفواتير والإيرادات</button>` : ''}
            </div>
            <div class="table-responsive mt-2">
                <table>
                    <thead><tr><th>رقم الفاتورة</th><th>كود الحجز</th><th>العميل</th><th>الفرع</th><th>العنصر والتفاصيل</th><th>المبلغ الإجمالي</th><th>الطريقة</th><th>التاريخ</th><th>إجراء الحذف</th></tr></thead>
                    <tbody>
                        ${(!appData.invoices || appData.invoices.length === 0) ? '<tr><td colspan="9">لا توجد فواتير معتمدة بعد</td></tr>' : 
                          appData.invoices.map(inv => {
                              let bDisplayName = (inv.branchId === 'dokki' || inv.branchId.includes('dokki')) ? 'فرع الدواجن' : 'فرع الحدائق';
                              return `<tr>
                              <td><strong>${inv.invoiceId}</strong></td>
                              <td>${inv.bookingNumber}</td>
                              <td>${inv.customerName}</td>
                              <td>${bDisplayName}</td>
                              <td>${inv.itemName}</td>
                              <td>${inv.price} جنيه</td>
                              <td>${inv.paymentMethod}</td>
                              <td>${inv.date}</td>
                              <td><button class="btn btn-danger btn-sm" onclick="deleteNosaInvoice('${inv.invoiceId}')">حذف وخصم المبلغ</button></td>
                          </tr>`;
                          }).join('')}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

function deleteNosaInvoice(invoiceId) {
    if (confirm('هل أنت متأكد من حذف هذه الفاتورة؟ سيتم حذفها نهائياً وخصم المبلغ من الإيرادات.')) {
        if (appData.invoices) {
            appData.invoices = appData.invoices.filter(inv => inv.invoiceId !== invoiceId);
            saveData();
            alert('تم حذف الفاتورة وتحديث الحسابات بنجاح!');
            loadNosaOverview();
        }
    }
}

function clearAllNosaInvoices() {
    if (confirm('تحذير: سيتم حذف كل الفواتير والإيرادات وكل الحجوزات من جميع الفروع والحسابات. هل تريد المتابعة؟')) {
        // التقفيل الكامل يمسح الدورة المالية والحجوزات المرتبطة بها من البيانات المشتركة.
        appData.invoices = [];
        appData.bookings = [];

        // إعادة عدادات الأكواد حتى يبدأ النظام من جديد بدون بقايا حجوزات قديمة.
        if (!appData.branchPrefixIndices) appData.branchPrefixIndices = { dokki: {}, haddayek: {} };
        appData.branchPrefixIndices.dokki = {};
        appData.branchPrefixIndices.haddayek = {};

        if (Array.isArray(appData.services)) appData.services.forEach(s => { s.currentCount = 0; });
        if (Array.isArray(appData.products)) appData.products.forEach(p => { p.currentCount = 0; });

        saveData();
        alert('تم تصفير وحذف كل الفواتير والإيرادات والحجوزات من جميع الفروع والحسابات بنجاح!');
        loadNosaOverview();
    }
}

function closeBranchDay(branchId) {
    const bName = branchId === 'dokki' ? 'فرع الدواجن' : 'فرع الحدائق';
    let todayStr = new Date().toLocaleDateString('ar-EG');
    if (confirm(`هل تريد عمل تقفيل اليوم لـ ${bName}؟ سيتم حذف حجوزات هذا الفرع فقط.`)) {
        if (!appData.closedDays) appData.closedDays = [];

        // تقفيل فرع واحد: حذف حجوزات هذا الفرع فقط، مع ترك فواتير وإيرادات الفرع كما هي.
        appData.bookings = appData.bookings.filter(b => b.branchId !== branchId);

        // تصفير طابور الأكواد والعدادات لهذا الفرع فقط.
        if (!appData.branchPrefixIndices) appData.branchPrefixIndices = { dokki: {}, haddayek: {} };
        appData.branchPrefixIndices[branchId] = {};
        const branchItems = [
            ...(Array.isArray(appData.services) ? appData.services : []),
            ...(Array.isArray(appData.products) ? appData.products : [])
        ];
        branchItems.forEach(item => {
            if (item.branchId === branchId) item.currentCount = 0;
        });

        // منع تكرار سجل التقفيل لنفس الفرع في نفس اليوم.
        appData.closedDays = appData.closedDays.filter(d => !(d.branchId === branchId && d.date === todayStr));
        appData.closedDays.push({ branchId, date: todayStr, closedAt: new Date().toLocaleTimeString('ar-EG') });

        saveData();
        alert(`تم تقفيل ${bName} وحذف حجوزاته فقط بنجاح، مع الإبقاء على فواتيره وإيراداته.`);
        loadNosaOverview();
    }
}

/* ========================= CLIENT BOOKINGS / ORDERS REALTIME SYNC ========================= */
(function(){
  let lastClientSyncHash = '';
  function clientDataHash(){
    try {
      return JSON.stringify({
        bookings: appData && appData.bookings ? appData.bookings : [],
        services: appData && appData.services ? appData.services : [],
        products: appData && appData.products ? appData.products : []
      });
    } catch(e){ return String(Date.now()); }
  }

  function refreshClientInquiryViews(){
    const clientView = document.getElementById('client-view');
    if(!clientView || clientView.style.display === 'none') return;

    // Re-render the existing client portal widgets without changing their layout.
    try {
      if(typeof loadClientBookings === 'function') loadClientBookings();
    } catch(e){ console.warn('client bookings refresh',e); }

    try {
      if(typeof loadClientOrders === 'function') loadClientOrders();
    } catch(e){ console.warn('client orders refresh',e); }

    try {
      if(typeof loadClientTracking === 'function') loadClientTracking();
    } catch(e){ console.warn('client tracking refresh',e); }

    try {
      if(typeof renderClientBookings === 'function') renderClientBookings();
    } catch(e){ console.warn('render client bookings',e); }

    try {
      if(typeof renderClientOrders === 'function') renderClientOrders();
    } catch(e){ console.warn('render client orders',e); }

    // These are harmless if the project version does not define them.
    try {
      if(typeof initClientPortalData === 'function') initClientPortalData();
    } catch(e){ console.warn('client portal refresh',e); }
  }

  function startClientRealtimeRefresh(){
    const h = clientDataHash();
    if(h === lastClientSyncHash) return;
    lastClientSyncHash = h;
    refreshClientInquiryViews();
  }

  // Hook the project's existing data-update path, regardless of which realtime
  // implementation V18 uses.
  const oldRefresh = window.refreshUIFromFirebase;
  if(typeof oldRefresh === 'function'){
    window.refreshUIFromFirebase = function(){
      const r = oldRefresh.apply(this, arguments);
      setTimeout(startClientRealtimeRefresh, 0);
      setTimeout(startClientRealtimeRefresh, 120);
      return r;
    };
  }

  // Firebase listener fallback: listen to the project's main data node when available.
  function attach(){
    try{
      if(window.firebase && firebase.database){
        const refs = [
          firebase.database().ref('salon_app_data'),
          firebase.database().ref('appData'),
          firebase.database().ref('nosa_app_data')
        ];
        refs.forEach(ref=>{
          ref.on('value', snap=>{
            if(!snap.exists()) return;
            const val = snap.val();
            if(val && typeof val === 'object'){
              // Only merge fields that exist; never erase local fields from a partial node.
              if(val.bookings) appData.bookings = Array.isArray(val.bookings) ? val.bookings : Object.values(val.bookings);
              if(val.services) appData.services = Array.isArray(val.services) ? val.services : Object.values(val.services);
              if(val.products) appData.products = Array.isArray(val.products) ? val.products : Object.values(val.products);
              if(val.invoices) appData.invoices = Array.isArray(val.invoices) ? val.invoices : Object.values(val.invoices);
              setTimeout(startClientRealtimeRefresh, 0);
            }
          });
        });
      }
    }catch(e){ console.warn('client realtime listener',e); }
  }

  window.addEventListener('load', attach);
  document.addEventListener('DOMContentLoaded', ()=>setTimeout(attach, 300));
  window.NOSA_CLIENT_REALTIME = { refresh: refreshClientInquiryViews };
})();


/* ========================= NOSA PRO COMMUNICATION CENTER — V10 ========================= */
const NOSA_PRO_COMM={
 root:()=>window.firebase&&firebase.database?firebase.database().ref('client_communications'):null,
 identity(){
   let uid=''; try{uid=(window.firebase&&firebase.auth&&firebase.auth().currentUser?.uid)||''}catch(_){ }
   const name=(document.getElementById('client-account-name')?.value||localStorage.getItem('nosa_client_name')||'').trim();
   const phone=(document.getElementById('client-account-phone')?.value||localStorage.getItem('nosa_client_phone')||'').trim();
   const branch=(document.getElementById('cs-branch')?.value||localStorage.getItem('nosa_client_branch')||'').trim();
   const accountKey=uid || (phone ? 'phone_'+phone.replace(/\D/g,'') : 'anonymous');
   return {uid,name,phone,branch,accountKey};
 },
 saveAccount(){
   const a=this.identity();
   if(a.name) localStorage.setItem('nosa_client_name',a.name);
   if(a.phone) localStorage.setItem('nosa_client_phone',a.phone);
   if(a.branch) localStorage.setItem('nosa_client_branch',a.branch);
   const n=document.getElementById('client-account-name'),p=document.getElementById('client-account-phone');
   if(n && !n.value && a.name) n.value=a.name;
   if(p && !p.value && a.phone) p.value=a.phone;
   return a;
 },
 esc(v){return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;')},
 saveLocal(kind,item){try{const k='nosa_'+kind;const a=JSON.parse(localStorage.getItem(k)||'[]');a.unshift(item);localStorage.setItem(k,JSON.stringify(a.slice(0,100)))}catch(_){ }},
 localItems(kind){try{return JSON.parse(localStorage.getItem('nosa_'+kind)||'[]')}catch(_){return[]}},
 render(id,items,empty){const el=document.getElementById(id);if(!el)return;if(!items.length){el.innerHTML=`<p class="text-muted">${empty}</p>`;return}el.innerHTML=items.map(x=>`<div class="comm-item"><div><b>${this.esc(x.subject||x.type||x.serviceName||'طلب')}</b><span>${this.esc(x.status||'جديد')}</span></div><p>${this.esc(x.message||'')}</p><small>${new Date(x.createdAt||Date.now()).toLocaleString('ar-EG')}</small>${x.reply?`<div class="comm-reply"><b>رد الإدارة:</b> ${this.esc(x.reply)}</div>`:''}</div>`).join('')},
 async submit(kind,payload){
   const a=this.saveAccount();
   if(!a.phone) throw new Error('اكتب رقم الهاتف في بيانات حساب العميل أولاً، ثم اضغط حفظ الحساب.');
   const item={id:'COM-'+Date.now(),kind,...payload,...a,status:'جديد',createdAt:Date.now(),source:'client'};
   this.saveLocal(kind,item);
   const ref=this.root();
   if(ref) await ref.child(kind).child(item.id).set(item);
   return item;
 },
 async loadForAccount(kind,target){
   const a=this.saveAccount(), ref=this.root();
   const local=this.localItems(kind).filter(x=>x.accountKey===a.accountKey || (a.phone&&x.phone===a.phone));
   if(!ref){this.render(target,local,'لا توجد طلبات سابقة.');return}
   try{
     const s=await ref.child(kind).orderByChild('accountKey').equalTo(a.accountKey).limitToLast(100).once('value');
     const all=[...local];s.forEach(c=>{const x=c.val();if(!all.some(y=>y.id===x.id))all.push(x)});all.sort((x,y)=>(y.createdAt||0)-(x.createdAt||0));this.render(target,all,'لا توجد طلبات سابقة.');
     ref.child(kind).orderByChild('accountKey').equalTo(a.accountKey).on('value',snap=>{const live=[];snap.forEach(c=>live.push(c.val()));live.sort((x,y)=>(y.createdAt||0)-(x.createdAt||0));this.render(target,live,'لا توجد طلبات سابقة.')});
   }catch(_){this.render(target,local,'تعذر تحميل الطلبات من قاعدة البيانات حالياً.')}
 }
};
function nosaInitCommunicationCenter(){
 const save=document.getElementById('save-client-account');
 if(save&&!save.dataset.ready){save.dataset.ready='1';save.onclick=()=>{const a=NOSA_PRO_COMM.saveAccount();nosaUpdateHomeSummary?.();nosaInitCommunicationCenter.refresh();alert(a.phone?'تم حفظ بيانات الحساب وربط الشكاوى والاستفسارات والتقييم بهذا الحساب.':'اكتب رقم الهاتف أولاً ثم احفظ الحساب.')}}
 NOSA_PRO_COMM.saveAccount();
 const c=document.getElementById('client-complaint-form');
 if(c&&!c.dataset.ready){c.dataset.ready='1';c.addEventListener('submit',async e=>{e.preventDefault();const status=document.getElementById('complaint-status');try{const x=await NOSA_PRO_COMM.submit('complaints',{type:document.getElementById('complaint-type').value,reference:document.getElementById('complaint-ref').value.trim(),message:document.getElementById('complaint-message').value.trim()});status.innerHTML=`<div class="wallet-box">تم إرسال الشكوى <b>${x.id}</b> بنجاح، وستظهر للإدارة ونوسا ماستر.</div>`;c.reset();nosaInitCommunicationCenter.refresh();nosaUpdateHomeSummary?.()}catch(err){status.innerHTML=`<div class="comm-error">${NOSA_PRO_COMM.esc(err.message||err)}</div>`}})}
 const q=document.getElementById('client-inquiry-form');
 if(q&&!q.dataset.ready){q.dataset.ready='1';q.addEventListener('submit',async e=>{e.preventDefault();const status=document.getElementById('inquiry-status');try{const x=await NOSA_PRO_COMM.submit('inquiries',{subject:document.getElementById('inquiry-subject').value.trim(),message:document.getElementById('inquiry-message').value.trim()});status.innerHTML=`<div class="wallet-box">تم إرسال الاستفسار <b>${x.id}</b> بنجاح، وستظهر للإدارة ونوسا ماستر.</div>`;q.reset();nosaInitCommunicationCenter.refresh();nosaUpdateHomeSummary?.()}catch(err){status.innerHTML=`<div class="comm-error">${NOSA_PRO_COMM.esc(err.message||err)}</div>`}})}
 nosaInitCommunicationCenter.refresh=()=>{NOSA_PRO_COMM.loadForAccount('complaints','client-complaints-list');NOSA_PRO_COMM.loadForAccount('inquiries','client-inquiries-list');if(window.NOSA_SERVICE_FEEDBACK){NOSA_SERVICE_FEEDBACK.loadBookings?.();NOSA_SERVICE_FEEDBACK.loadMine?.()}};
 nosaInitCommunicationCenter.refresh();
}
window.nosaInitCommunicationCenter=nosaInitCommunicationCenter;
/* ========================= NOSA SERVICE FEEDBACK — V10 ========================= */
const NOSA_SERVICE_FEEDBACK={
 bookings:[],
 accountKey(){return NOSA_PRO_COMM.saveAccount().accountKey},
 ref(){return window.firebase&&firebase.database?firebase.database().ref('client_communications/feedback'):null},
 async loadBookings(){
   const a=NOSA_PRO_COMM.saveAccount(); let arr=[];
   const candidates=['clientBookings','myBookings','bookings'];
   for(const k of candidates){if(Array.isArray(window[k])&&window[k].length){arr=window[k].slice();break}}
   if(!arr.length && Array.isArray(appData?.bookings)) arr=appData.bookings.slice();
   if(!arr.length && window.localStorage){
     for(const k of ['appData','nosa_appData']){
       try{const raw=localStorage.getItem(k);const obj=raw?JSON.parse(raw):null;if(obj&&Array.isArray(obj.bookings)&&obj.bookings.length){arr=obj.bookings.slice();break}}catch(_){ }
     }
   }
   if(!arr.length && window.firebase&&firebase.database){
     try{const snap=await firebase.database().ref('bookings').orderByChild('accountKey').equalTo(a.accountKey).once('value');snap.forEach(c=>arr.push({...c.val(),id:c.key}))}catch(_){ }
     if(!arr.length&&a.phone){
       try{const snap=await firebase.database().ref('bookings').orderByChild('customerPhone').equalTo(a.phone).once('value');snap.forEach(c=>arr.push({...c.val(),id:c.key}))}catch(_){ }
       try{const snap=await firebase.database().ref('bookings').orderByChild('phone').equalTo(a.phone).once('value');snap.forEach(c=>arr.push({...c.val(),id:c.key}))}catch(_){ }
     }
   }
   this.bookings=arr.filter(x=>{
     if(!x || x.type==='حجز منتجات') return false;
     const hasService=!!(x.serviceName||x.service||x.itemName||x.name);
     if(!hasService) return false;
     if(a.phone){const p=String(x.customerPhone||x.phone||'').trim();if(p&&p!==a.phone)return false;}
     return true;
   });
   this.populate();
 },
 populate(){
   const bs=document.getElementById('feedback-booking'),ss=document.getElementById('feedback-service');
   if(!bs||!ss)return;
   const rowsMap=new Map();
   this.bookings.forEach((b,i)=>{
     const id=String(b.id||b.bookingId||b.bookingNumber||i);
     const service=String(b.serviceName||b.service||b.itemName||b.name||'خدمة');
     rowsMap.set(id,{...b,id,service});
   });
   const rows=[...rowsMap.values()];

   // الحجز اختياري: نعرض الحجوزات السابقة إن وجدت، ونضيف دائمًا خيار "بدون حجز".
   bs.innerHTML='<option value="">بدون حجز — تقييم عام للخدمة</option>'+
     rows.map(b=>`<option value="${b.id.replace(/"/g,'&quot;')}">${b.id} — ${b.service}</option>`).join('');

   // قائمة الخدمات تأتي من كتالوج الصالون، وليس من الحجوزات فقط.
   const catalog=Array.isArray(appData?.services)?appData.services:[];
   const serviceMap=new Map();
   catalog.forEach(x=>{
     const name=String(x.name||x.serviceName||x.service||'').trim();
     if(name) serviceMap.set(String(x.id||name),{id:String(x.id||name),name});
   });
   // نضيف أي خدمة ظهرت في الحجوزات حتى لو لم تعد موجودة في الكتالوج المحلي.
   rows.forEach(b=>{
     const id=String(b.serviceId||b.service||b.serviceName||b.service);
     const name=String(b.service||b.serviceName||'خدمة');
     if(name&&!serviceMap.has(id)) serviceMap.set(id,{id,name});
   });
   const services=[...serviceMap.values()];
   ss.innerHTML=services.length?
     '<option value="">اختر الخدمة</option>'+services.map(x=>`<option value="${x.id.replace(/"/g,'&quot;')}">${x.name}</option>`).join(''):
     '<option value="">لا توجد خدمات متاحة حاليًا</option>';
   bs.onchange=()=>{
     const b=rows.find(x=>x.id===bs.value);
     if(b) {
       const sid=String(b.serviceId||b.service||b.serviceName||b.service||'');
       const opt=[...ss.options].find(o=>o.value===sid || o.textContent===String(b.service));
       if(opt) ss.value=opt.value;
     }
   };
 },
 async alreadyRated(service,bookingId){
   const key=this.accountKey(), r=this.ref();
   const check=arr=>arr.some(x=>x.accountKey===key && (bookingId ? String(x.bookingId||'')===String(bookingId) : (!x.bookingId && String(x.serviceId||x.serviceName||'')===String(service))));
   try{
     const local=JSON.parse(localStorage.getItem('nosa_feedback')||'[]');
     if(check(local)) return true;
   }catch(_){ }
   if(!r)return false;
   try{const snap=await r.orderByChild('accountKey').equalTo(key).once('value');let yes=false;snap.forEach(c=>{if(check([c.val()]))yes=true});return yes}catch(_){return false}
 },
 async submit(){
   const service=document.getElementById('feedback-service')?.value||'';
   const serviceText=document.getElementById('feedback-service')?.selectedOptions?.[0]?.textContent||service;
   const bookingId=document.getElementById('feedback-booking')?.value||'';
   const rating=Number(document.getElementById('feedback-rating')?.value||0);
   const message=document.getElementById('feedback-message')?.value?.trim()||'';
   if(!service||!rating||!message) throw new Error('اختر الخدمة والتقييم واكتب رأيك. الحجز اختياري.');
   if(await this.alreadyRated(service,bookingId)) throw new Error(bookingId?'تم تقييم هذا الحجز من قبل.':'تم تسجيل تقييمك لهذه الخدمة من قبل.');
   const a=NOSA_PRO_COMM.saveAccount();
   if(!a.name || a.name==='عميل') throw new Error('اكتب اسم العميل واحفظ الحساب أولاً لإرسال التقييم باسمك.');
   const item={id:'FB-'+Date.now(),kind:'feedback',accountKey:a.accountKey,uid:a.uid||'',name:a.name||'عميل',branch:a.branch||'',serviceId:service,serviceName:serviceText,bookingId:bookingId||'',rating,message,status:'تم الاستلام',createdAt:Date.now(),source:'client',evaluationType:bookingId?'مرتبط بحجز':'تقييم عام'};
   try{const old=JSON.parse(localStorage.getItem('nosa_feedback')||'[]');localStorage.setItem('nosa_feedback',JSON.stringify([item,...old].slice(0,100)))}catch(_){ }
   const r=this.ref(); if(r) await r.child(item.id).set(item);
   return item;
 },
 loadMine(){
   const target=document.getElementById('client-feedback-list'),r=this.ref(),a=this.accountKey();if(!target)return;
   const local=(()=>{try{return JSON.parse(localStorage.getItem('nosa_feedback')||'[]').filter(x=>x.accountKey===a)}catch(_){return[]}})();
   if(!r){target.innerHTML=local.length?local.map(this.row.bind(this)).join(''):'<p class="text-muted">لم ترسل أي تقييمات بعد.</p>';return}
   r.orderByChild('accountKey').equalTo(a).on('value',s=>{const arr=[];s.forEach(c=>arr.push(c.val()));arr.sort((x,y)=>(y.createdAt||0)-(x.createdAt||0));target.innerHTML=arr.length?arr.map(this.row.bind(this)).join(''):'<p class="text-muted">لم ترسل أي تقييمات بعد.</p>'})
 },
 row(x){return `<div class="comm-item"><div><b>${String(x.serviceName||'خدمة')}</b><span>${'★'.repeat(Number(x.rating)||0)}${'☆'.repeat(5-(Number(x.rating)||0))}</span></div><p>${String(x.message||'').replace(/</g,'&lt;')}</p><small>${x.bookingId?'مرتبط بالحجز: '+x.bookingId:'تقييم عام بدون حجز'} — ${new Date(x.createdAt||Date.now()).toLocaleString('ar-EG')} — ${x.status||''}</small></div>`}
};
function nosaInitServiceFeedback(){
 const form=document.getElementById('client-feedback-form');if(!form||form.dataset.ready)return;form.dataset.ready='1';
 document.querySelectorAll('#feedback-stars button').forEach(btn=>btn.addEventListener('click',()=>{const n=Number(btn.dataset.rating);document.getElementById('feedback-rating').value=n;document.querySelectorAll('#feedback-stars button').forEach(b=>b.classList.toggle('selected',Number(b.dataset.rating)<=n))}));
 form.addEventListener('submit',async e=>{e.preventDefault();const status=document.getElementById('feedback-status');try{const x=await NOSA_SERVICE_FEEDBACK.submit();status.innerHTML=`<div class="wallet-box">شكرًا ❤️ تم تسجيل تقييمك باسم <b>${NOSA_PRO_COMM.esc(x.name)}</b> للخدمة <b>${x.serviceName}</b> ${x.bookingId?'المرتبط بالحجز '+x.bookingId:'كتقييم عام بدون حجز'} — رقم الهاتف لا يظهر مع التقييم.</div>`;form.reset();document.getElementById('feedback-booking').value='';document.querySelectorAll('#feedback-stars button').forEach(b=>b.classList.remove('selected'));NOSA_SERVICE_FEEDBACK.loadMine()}catch(err){status.innerHTML=`<div class="comm-error">${String(err.message||err)}</div>`}});
 NOSA_SERVICE_FEEDBACK.loadBookings();NOSA_SERVICE_FEEDBACK.loadMine();
}
window.nosaInitServiceFeedback=nosaInitServiceFeedback;

function loadNosaAccountSecurity(){
    if(userRole!=='nosa'){
        alert('إدارة كلمات مرور الحسابات متاحة لنوسا Master Admin فقط.');
        return;
    }
    const area=document.getElementById('dynamic-content-area');
    if(!area) return;
    const accounts=Object.keys(validAccounts);
    area.innerHTML=`<h2><i class="fa-solid fa-key"></i> إدارة كلمات مرور الحسابات</h2>
      <p class="text-muted">يمكن لنوسا Master Admin تغيير كلمة مرور أي حساب إداري. التغيير يُحفظ في بيانات النظام ويُستخدم عند تسجيل الدخول التالي.</p>
      <div class="card security-card">
        <div class="security-warning"><i class="fa-solid fa-shield-halved"></i> ملاحظة: هذه المنظومة الحالية تستخدم نظام دخول داخلي داخل المشروع. لتأمين حقيقي بمستوى Firebase Authentication نحتاج نقل الحسابات إلى Firebase Auth/Backend وعدم تخزين كلمات المرور في واجهة المتصفح.</div>
        <div class="account-password-grid">
          ${accounts.map(email=>{
            const a=validAccounts[email];
            const pass=(appData.accountPasswords&&appData.accountPasswords[email])||a.pass||'';
            return `<div class="account-password-row" data-email="${NOSA_PRO_COMM.esc(email)}">
              <div class="account-password-info"><b>${NOSA_PRO_COMM.esc(a.name)}</b><span>${NOSA_PRO_COMM.esc(email)}</span></div>
              <div class="account-password-controls"><input type="password" class="account-new-password" value="${NOSA_PRO_COMM.esc(pass)}" minlength="6" placeholder="كلمة مرور جديدة"><button class="btn btn-primary btn-sm save-account-password"><i class="fa-solid fa-floppy-disk"></i> حفظ</button></div>
            </div>`;
          }).join('')}
        </div>
      </div>`;
    area.querySelectorAll('.save-account-password').forEach(btn=>btn.onclick=()=>{
        const row=btn.closest('.account-password-row');
        const email=row.dataset.email;
        const input=row.querySelector('.account-new-password');
        const newPass=input.value.trim();
        if(newPass.length<6){alert('كلمة المرور يجب أن تكون 6 أحرف/أرقام على الأقل.');return;}
        appData.accountPasswords=appData.accountPasswords||{};
        appData.accountPasswords[email]=newPass;
        saveData();
        // تأكيد مزامنة كلمة المرور فورًا؛ لا ننتظر أي تحديث واجهة آخر.
        if (firebaseDataRef && firebaseReady && !firebaseApplyingRemote) {
            firebaseApplyingRemote = true;
            firebaseDataRef.update({ accountPasswords: cloneData(appData.accountPasswords) })
              .then(()=>{
                  firebaseLastSyncedData = firebaseLastSyncedData || {};
                  firebaseLastSyncedData.accountPasswords = cloneData(appData.accountPasswords);
                  firebaseDirtyKeys.delete('accountPasswords');
              })
              .catch(err=>console.error('Password sync error:', err))
              .finally(()=>{ firebaseApplyingRemote = false; });
        }
        alert(`تم تغيير كلمة مرور الحساب ${email} بنجاح. الباسورد القديم لم يعد صالحًا، والباسورد الجديد أصبح هو المعتمد.`);
    });
}

function loadNosaCommunicationsCenter(){
    if(userRole!=='nosa' && userRole!=='admin'){
        alert('هذا القسم متاح للإدارة ونوسا ماستر فقط.');
        return;
    }
    const area=document.getElementById('dynamic-content-area'); if(!area)return;
    area.innerHTML=`<div class="comm-center-page">
      <div class="comm-center-title">
        <div>
          <h2><i class="fas fa-headset"></i> مركز شكاوى العملاء والاستفسارات والآراء</h2>
          <p class="text-muted">متابعة جميع رسائل العملاء والرد عليها مباشرة. التحديثات تظهر لحظيًا لكل حساب إداري ونوسا ماستر.</p>
        </div>
      </div>
      <div class="comm-center-toolbar card">
        <div class="comm-center-stat"><span>الشكاوى</span><b id="comm-count-complaints">0</b></div>
        <div class="comm-center-stat"><span>الاستفسارات</span><b id="comm-count-inquiries">0</b></div>
        <div class="comm-center-stat"><span>التقييمات</span><b id="comm-count-feedback">0</b></div>
        <div class="comm-filters">
          <label>عرض:</label>
          <select id="comm-admin-type"><option value="all">الكل</option><option value="complaints">الشكاوى</option><option value="inquiries">الاستفسارات</option><option value="feedback">الآراء والتقييم</option></select>
          <select id="comm-admin-status"><option value="all">كل الحالات</option><option>جديد</option><option>قيد المتابعة</option><option>تم الرد</option><option>مغلق</option></select>
        </div>
      </div>
      <div id="admin-communications-sections" class="comm-center-sections">
        <p class="text-muted">جاري تحميل طلبات العملاء...</p>
      </div>
    </div>`;

    const ref=window.firebase&&firebase.database?firebase.database().ref('client_communications'):null;
    if(!ref){
      const el=document.getElementById('admin-communications-sections');
      if(el)el.innerHTML='<p class="text-muted">تعذر الاتصال بقاعدة البيانات حاليًا.</p>';
      return;
    }

    const state={complaints:[],inquiries:[],feedback:[]};
    const labels={complaints:'الشكاوى',inquiries:'الاستفسارات',feedback:'الآراء والتقييمات'};
    const icons={complaints:'fa-triangle-exclamation',inquiries:'fa-circle-question',feedback:'fa-star'};
    const listeners=[];
    const escapeAttr=v=>NOSA_PRO_COMM.esc(v).replace(/`/g,'&#96;');

    const render=()=>{
      const type=document.getElementById('comm-admin-type')?.value||'all';
      const status=document.getElementById('comm-admin-status')?.value||'all';
      ['complaints','inquiries','feedback'].forEach(kind=>{
        const countEl=document.getElementById('comm-count-'+kind);
        if(countEl)countEl.textContent=state[kind].filter(x=>status==='all'||(x.status||'جديد')===status).length;
      });
      const sections=document.getElementById('admin-communications-sections'); if(!sections)return;
      const kinds=type==='all'?['complaints','inquiries','feedback']:[type];
      sections.innerHTML=kinds.map(kind=>{
        const rows=state[kind].filter(x=>status==='all'||(x.status||'جديد')===status).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
        return `<section class="comm-section comm-section-${kind}">
          <div class="comm-section-head"><h3><i class="fa-solid ${icons[kind]}"></i> ${labels[kind]}</h3><span>${rows.length} طلب</span></div>
          <div class="comm-section-list">${rows.length?rows.map(x=>`<article class="admin-comm-card" data-id="${escapeAttr(x.id)}" data-kind="${kind}">
            <div class="admin-comm-card-top">
              <div><strong>${NOSA_PRO_COMM.esc(x.name||'عميل')}</strong>${x.kind!=='feedback'&&x.phone?`<span>${NOSA_PRO_COMM.esc(x.phone)}</span>`:''}</div>
              <span class="comm-status-pill">${NOSA_PRO_COMM.esc(x.status||'جديد')}</span>
            </div>
            <div class="admin-comm-card-info">
              ${x.branch?`<span><i class="fa-solid fa-location-dot"></i> ${NOSA_PRO_COMM.esc(x.branch)}</span>`:''}
              ${x.rating?`<span class="comm-stars">${'★'.repeat(Number(x.rating))}${'☆'.repeat(5-Number(x.rating))}</span>`:''}
              <span><i class="fa-regular fa-clock"></i> ${new Date(x.createdAt||Date.now()).toLocaleString('ar-EG')}</span>
            </div>
            <div class="admin-comm-message">
              ${x.subject||x.type||x.serviceName?`<h4>${NOSA_PRO_COMM.esc(x.subject||x.type||x.serviceName)}</h4>`:''}
              <p>${NOSA_PRO_COMM.esc(x.message||'')}</p>
              ${x.reference?`<small>المرجع: ${NOSA_PRO_COMM.esc(x.reference)}</small>`:''}
              ${x.bookingId?`<small>الحجز: ${NOSA_PRO_COMM.esc(x.bookingId)}</small>`:''}
            </div>
            <div class="admin-comm-reply-area">
              <select class="comm-status-select" aria-label="حالة الطلب">${['جديد','قيد المتابعة','تم الرد','مغلق'].map(s=>`<option ${x.status===s?'selected':''}>${s}</option>`).join('')}</select>
              <textarea class="comm-reply-input" rows="2" placeholder="اكتب الرد على العميل...">${NOSA_PRO_COMM.esc(x.reply||'')}</textarea>
              <div class="admin-comm-actions">
                <button class="btn btn-primary btn-sm comm-save-btn"><i class="fa-solid fa-paper-plane"></i> حفظ وإرسال الرد</button>
                ${userRole==='nosa'?'<button class="btn btn-danger btn-sm comm-delete-btn"><i class="fa-solid fa-trash"></i> حذف</button>':''}
              </div>
              ${x.reply?`<div class="comm-existing-reply"><b>آخر رد من الإدارة:</b><span>${NOSA_PRO_COMM.esc(x.reply)}</span></div>`:''}
            </div>
          </article>`).join(''):'<div class="comm-empty">لا توجد طلبات في هذا القسم حاليًا.</div>'}</div>
        </section>`;
      }).join('');

      sections.querySelectorAll('.comm-save-btn').forEach(btn=>btn.onclick=async()=>{
        const card=btn.closest('.admin-comm-card'),kind=card.dataset.kind,id=card.dataset.id;
        const status=card.querySelector('.comm-status-select').value,reply=card.querySelector('.comm-reply-input').value.trim();
        btn.disabled=true;
        try{
          await ref.child(kind).child(id).update({status,reply,updatedAt:Date.now(),updatedBy:userRole});
          const item=state[kind].find(x=>String(x.id)===String(id));
          if(item){item.status=status;item.reply=reply;item.updatedAt=Date.now();item.updatedBy=userRole;}
          render();
        }catch(err){alert('تعذر حفظ الرد: '+(err.message||err));btn.disabled=false;}
      });
      sections.querySelectorAll('.comm-delete-btn').forEach(btn=>btn.onclick=async()=>{
        if(userRole!=='nosa'){alert('الحذف متاح لنوسا Master Admin فقط.');return;}
        const card=btn.closest('.admin-comm-card'),kind=card.dataset.kind,id=card.dataset.id;
        const label=kind==='complaints'?'الشكوى':kind==='inquiries'?'الاستفسار':'التقييم';
        if(!confirm(`هل تريد حذف ${label} نهائيًا؟ لا يمكن التراجع عن هذا الإجراء.`)) return;
        btn.disabled=true;
        try{
          await ref.child(kind).child(id).remove();
          try{
            const localKey=kind==='feedback'?'nosa_feedback':('nosa_'+kind);
            const cached=JSON.parse(localStorage.getItem(localKey)||'[]').filter(x=>x.id!==id);
            localStorage.setItem(localKey,JSON.stringify(cached));
          }catch(_){ }
          state[kind]=state[kind].filter(x=>String(x.id)!==String(id));
          window.dispatchEvent(new CustomEvent('nosa:communication-deleted',{detail:{kind,id}}));
          render();
        }catch(err){alert('تعذر حذف الطلب: '+(err.message||err));btn.disabled=false;}
      });
    };

    ['complaints','inquiries','feedback'].forEach(kind=>{
      const listener=ref.child(kind).limitToLast(300).on('value',snap=>{
        const arr=[];
        snap.forEach(c=>arr.push({...c.val(),id:c.key,kind}));
        arr.sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
        state[kind]=arr;
        render();
      },err=>console.error('Communication center sync error:',kind,err));
      listeners.push({kind,listener});
    });

    document.getElementById('comm-admin-type').onchange=render;
    document.getElementById('comm-admin-status').onchange=render;
}

/* ================= NOSA V9 — CLIENT DASHBOARD NAVIGATION ================= */
function nosaOpenClientTab(targetId){
  document.querySelectorAll('.client-tab-content').forEach(c=>c.classList.remove('active'));
  const target=document.getElementById(targetId);
  if(target) target.classList.add('active');
  document.querySelectorAll('.client-side-link').forEach(b=>b.classList.toggle('active',b.dataset.openTab===targetId));
  document.querySelectorAll('.client-quick-card').forEach(b=>b.classList.toggle('active',b.dataset.openTab===targetId));
  const main=document.querySelector('.client-dashboard-main'); if(main) main.scrollTo({top:0,behavior:'smooth'});
}
document.addEventListener('click',e=>{const b=e.target.closest('[data-open-tab]');if(!b)return;e.preventDefault();nosaOpenClientTab(b.dataset.openTab);});
function nosaSyncClientAccountFromBookingForm(){
 const name=document.getElementById('client-account-name'),phone=document.getElementById('client-account-phone'),branch=document.getElementById('cs-branch');
 const csn=document.getElementById('cs-name'),csp=document.getElementById('cs-phone');
 const n=document.getElementById('client-account-name'), p=document.getElementById('client-account-phone');
 if(n&&csn&&csn.value&&!n.value)n.value=csn.value;
 if(p&&csp&&csp.value&&!p.value)p.value=csp.value;
 if(branch&&branch.value)localStorage.setItem('nosa_client_branch',branch.value);
 if((csn&&csn.value)||(csp&&csp.value)) NOSA_PRO_COMM.saveAccount();
}
['cs-name','cs-phone'].forEach(id=>document.getElementById(id)?.addEventListener('input',nosaSyncClientAccountFromBookingForm));

function nosaUpdateHomeSummary(){
  const name=(localStorage.getItem('nosa_client_name')||'عميل نوسا').trim();
  const set=(id,v)=>{const el=document.getElementById(id);if(el)el.textContent=v};
  set('sidebar-client-name',name||'عميل نوسا');set('client-home-account-name',name||'عميل نوسا');
  const get=k=>{try{return JSON.parse(localStorage.getItem(k)||'[]').length}catch(_){return 0}};
  set('home-bookings-count',get('nosa_bookings'));set('home-orders-count',get('nosa_orders'));set('home-complaints-count',get('nosa_complaints'));set('home-inquiries-count',get('nosa_inquiries'));set('home-feedback-count',get('nosa_feedback'));
}


/* Keep the client inquiry panel fresh whenever the customer opens it. */
(function(){
  const oldSwitch = window.switchClientTab;
  if(typeof oldSwitch === 'function'){
    window.switchClientTab = function(tab){
      const result = oldSwitch.apply(this, arguments);
      setTimeout(()=>window.NOSA_CLIENT_REALTIME?.refresh?.(), 0);
      return result;
    };
  }
})();
