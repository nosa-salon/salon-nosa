// ==========================================
// ملف script.js الكامل والنهائي لتطبيق صالون نوسا (مع إضافة خيارات الشحن والعنوان)
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
    }
};

function saveData() {
    localStorage.setItem('salon_app_data', JSON.stringify(appData));
}

document.addEventListener('DOMContentLoaded', () => {
    initEventListeners();
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

            if (validAccounts[email] && validAccounts[email].pass === password) {
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
            initClientPortalData();
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
            e.target.classList.add('active');
            const targetId = e.target.getAttribute('data-tab');
            document.getElementById(targetId).classList.add('active');
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

            serviceObj.currentCount += 1;
            serviceObj.max -= 1;

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
                shippingCost: 0,
                totalAmount: serviceObj.price,
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
            productObj.currentCount += requestedQty;
            productObj.qty -= requestedQty;

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
            
            let userBookings = appData.bookings.filter(b => b.customerPhone === phone);
            if (selectedBranch) {
                userBookings = userBookings.filter(b => b.branchId === selectedBranch);
            }

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

                let totalDisplayPrice = b.totalAmount || (b.price + (b.shippingCost || 0));

                html += `
                <div class="card mt-3" style="border-right: 5px solid var(--primary-dark);">
                    <p><strong>الفرع:</strong> ${bName}</p>
                    <p><strong>كود الحجز:</strong> <span style="color:var(--primary-dark); font-size:1.3rem;">${b.bookingNumber}</span> (بادئة الكود: <strong>${pCode}</strong>)</p>
                    <p><strong>الخدمة/المنتج:</strong> ${b.itemName} (${b.type})</p>
                    <p><strong>الكمية:</strong> ${qtyDisplay}</p>
                    <p><strong>إجمالي المطلوب (شامل الشحن إن وجد):</strong> <span style="color:#c0392b; font-weight:bold;">${totalDisplayPrice} جنيه</span></p>
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

    const subtotal = productObj.price * qty;

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
                ${s.name} - السعر: ${s.price} ج - الكود المتاح: (${generatedCode}) - المتبقي: ${s.max}
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
                ${p.name} - السعر: ${p.price} ج - الكود المتاح: (${generatedCode}) - المتبقي بالمخزن: ${p.qty}
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
    let finalDisplayTotal = bData.totalAmount || (bData.price + (bData.shippingCost || 0));
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
        <p><strong>الإجمالي الكلي:</strong> <span style="color:#c0392b; font-weight:bold; font-size:1.1rem;">${finalDisplayTotal} جنيه</span></p>
        <p><strong>طريقة الدفع:</strong> ${bData.paymentMethod === 'cash' ? 'نقدي (كاش)' : 'فودافون كاش'}</p>
        <p><strong>الحالة:</strong> ${bData.paymentStatus}</p>
    `;
    document.getElementById('ticket-modal').classList.remove('hidden');
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
            <li><a href="javascript:void(0);" onclick="loadAdminShippingSection()"><i class="fa-solid fa-truck"></i> إدارة أسعار الشحن والتوصيل</a></li>
        `;
        loadNosaOverview();
    } else if (userRole === 'admin') {
        if(roleBadge) roleBadge.innerText = 'مسؤول العروض والمنتجات';
        menu.innerHTML = `
            <li><a href="javascript:void(0);" onclick="loadAdminOffersSection()"><i class="fa-solid fa-tags"></i> إدارة العروض والخدمات والمنتجات</a></li>
            <li><a href="javascript:void(0);" onclick="loadAdminWalletsSection()"><i class="fa-solid fa-wallet"></i> أرقام فودافون كاش</a></li>
            <li><a href="javascript:void(0);" onclick="loadAdminShippingSection()"><i class="fa-solid fa-truck"></i> إدارة أسعار الشحن والتوصيل</a></li>
            <li><a href="javascript:void(0);" onclick="loadAdminPaymentsSection()"><i class="fa-solid fa-check-circle"></i> مراجعة فودافون كاش</a></li>
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
                        <tr><th>النوع</th><th>الاسم</th><th>السعر</th><th>الكمية المتاحة وتم الحجز</th><th>البادئة</th><th>تصفير العداد</th></tr>
                    </thead>
                    <tbody>
    `;

    if (branchServices.length > 0 || branchProducts.length > 0) {
        branchServices.forEach(s => {
            html += `<tr>
                <td><span class="badge" style="background:#2980b9; color:#fff;">خدمة</span></td>
                <td>${s.name}</td>
                <td>${s.price} جنيه</td>
                <td><strong>المتبقي:</strong> ${s.max} | <strong>تم حجز:</strong> ${s.currentCount || 0}</td>
                <td><span class="badge" style="background:#34495e; color:#fff;">${s.codePrefix || 'NOSA'}</span></td>
                <td><button class="btn btn-danger btn-sm" onclick="resetItemCount('${s.id}', 'service')"><i class="fa-solid fa-rotate-left"></i> تصفير عداد الحجز</button></td>
            </tr>`;
        });
        branchProducts.forEach(p => {
            html += `<tr>
                <td><span class="badge" style="background:#8e44ad; color:#fff;">منتج</span></td>
                <td>${p.name}</td>
                <td>${p.price} جنيه</td>
                <td><strong>المتبقي بالمخزن:</strong> ${p.qty} | <strong>تم حجز:</strong> ${p.currentCount || 0}</td>
                <td><span class="badge" style="background:#34495e; color:#fff;">${p.codePrefix || 'NOSA'}</span></td>
                <td><button class="btn btn-danger btn-sm" onclick="resetItemCount('${p.id}', 'product')"><i class="fa-solid fa-rotate-left"></i> تصفير عداد الحجز</button></td>
            </tr>`;
        });
    } else {
        html += `<tr><td colspan="6">لا توجد خدمات أو منتجات مضافة لهذا الفرع بعد.</td></tr>`;
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
                            <th>المبلغ الإجمالي</th>
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
                    actionBtn = `<div style="display:flex; flex-direction:column; gap:5px;"><button class="btn btn-primary btn-sm" onclick="confirmBranchCashPayment('${b.id}')">تأكيد الكاش وإصدار الفاتورة</button><br>${statusControlHtml}</div>`;
                } else {
                    actionBtn = `<div style="display:flex; flex-direction:column; gap:5px;"><button class="btn btn-danger btn-sm" onclick="deleteBranchBooking('${b.id}')">حذف الحجز</button><br>${statusControlHtml}</div>`;
                }
            } else {
                actionBtn = `<div style="display:flex; flex-direction:column; gap:5px;"><span class="badge">${b.paymentStatus}</span><br>${statusControlHtml}</div>`;
            }

            let detailsCol = `${b.itemName} ${b.type === 'حجز منتجات' ? `<br><span class="badge" style="background:#e67e22; color:#fff;">${b.quantity || 1} قطعة</span>` : ''}`;
            let deliveryCol = b.type === 'حجز منتجات' ? `<strong>${b.deliveryTypeName}</strong><br><small style="color:#666;">العنوان: ${b.address}</small>` : `-`;
            let totalDisplayPrice = b.totalAmount || (b.price + (b.shippingCost || 0));

            html += `<tr>
                <td>${b.customerName}<br><small>${b.customerPhone}</small></td>
                <td><strong>${b.bookingNumber}</strong></td>
                <td>${detailsCol}</td>
                <td>${deliveryCol}</td>
                <td><strong>${totalDisplayPrice} ج</strong></td>
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

function loadAdminOffersSection() {
    const area = document.getElementById('dynamic-content-area');
    if (!area) return;
    area.innerHTML = `
        <h2>إدارة عروض الخدمات والمنتجات</h2>
        <div class="card mt-3">
            <form id="admin-add-service-form">
                <div class="form-row">
                    <div class="form-group">
                        <label>الفرع</label>
                        <select id="adm-branch" required>
                            <option value="dokki">فرع الدواجن</option>
                            <option value="haddayek">فرع الحدائق</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>النوع</label>
                        <select id="adm-type" required>
                            <option value="service">خدمة</option>
                            <option value="product">منتج</option>
                        </select>
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label>الاسم</label>
                        <input type="text" id="adm-name" required placeholder="اسم الخدمة أو المنتج">
                    </div>
                    <div class="form-group">
                        <label>السعر للقطعة</label>
                        <input type="number" id="adm-price" required placeholder="السعر">
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label>العدد الإجمالي المتاح / المخزون</label>
                        <input type="number" id="adm-max" required placeholder="مثال: 15">
                    </div>
                    <div class="form-group">
                        <label>بادئة كود التسلسل (مثال: AMANY, DODO, NOSA)</label>
                        <input type="text" id="adm-prefix" required placeholder="اسم الكود بالإنجليزية">
                    </div>
                </div>
                <button type="submit" class="btn btn-primary">إضافة الخدمة/المنتج</button>
            </form>
        </div>
        <div class="card mt-4"><div id="admin-services-list"></div></div>
    `;
    renderAdminServicesTable();

    const addServForm = document.getElementById('admin-add-service-form');
    if(addServForm) {
        addServForm.onsubmit = function(e) {
            e.preventDefault();
            const type = document.getElementById('adm-type').value;
            const newItem = {
                id: 'ITM-' + Date.now(),
                branchId: document.getElementById('adm-branch').value,
                name: document.getElementById('adm-name').value,
                price: parseFloat(document.getElementById('adm-price').value),
                max: parseInt(document.getElementById('adm-max').value),
                qty: parseInt(document.getElementById('adm-max').value),
                currentCount: 0,
                codePrefix: document.getElementById('adm-prefix').value.trim().toUpperCase()
            };
            if (type === 'service') {
                appData.services.push(newItem);
            } else { 
                appData.products.push(newItem); 
            }
            saveData();
            e.target.reset();
            renderAdminServicesTable();
            alert('تمت الإضافة بنجاح وتفعيل الكود في قائمة إدارة الفرع والاستعلام!');
        };
    }
}

function renderAdminServicesTable() {
    const listDiv = document.getElementById('admin-services-list');
    if (!listDiv) return;
    let html = `<table><thead><tr><th>النوع</th><th>الفرع</th><th>الاسم</th><th>السعر</th><th>العدد/المتبقي</th><th>البادئة (الكود)</th><th>إجراء</th></tr></thead><tbody>`;
    appData.services.forEach(s => {
        html += `<tr><td>خدمة</td><td>${s.branchId === 'dokki' ? 'الدواجن' : 'الحدائق'}</td><td>${s.name}</td><td>${s.price}</td><td>${s.max}</td><td><span class="badge" style="background:#34495e; color:#fff;">${s.codePrefix || 'NOSA'}</span></td><td><button class="btn btn-danger btn-sm" onclick="deleteItem('${s.id}', 'service')">حذف</button></td></tr>`;
    });
    appData.products.forEach(p => {
        html += `<tr><td>منتج</td><td>${p.branchId === 'dokki' ? 'الدواجن' : 'الحدائق'}</td><td>${p.name}</td><td>${p.price}</td><td>${p.qty}</td><td><span class="badge" style="background:#34495e; color:#fff;">${p.codePrefix || 'NOSA'}</span></td><td><button class="btn btn-danger btn-sm" onclick="deleteItem('${p.id}', 'product')">حذف</button></td></tr>`;
    });
    html += `</tbody></table>`;
    listDiv.innerHTML = html;
}

function deleteItem(id, type) {
    if(type === 'service') appData.services = appData.services.filter(s => s.id !== id);
    else appData.products = appData.products.filter(p => p.id !== id);
    saveData();
    renderAdminServicesTable();
}

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
    let html = `<table><thead><tr><th>العميل</th><th>الكود</th><th>الفرع</th><th>التفاصيل والاستلام</th><th>الإجمالي</th><th>الحالة</th><th>الإجراء</th></tr></thead><tbody>`;
    walletBookings.forEach(b => {
        let isAlreadyInvoiced = appData.invoices && appData.invoices.some(inv => inv.bookingNumber === b.bookingNumber);
        let btn = '';
        if (b.paymentStatus === 'جاري المراجعة' && !isAlreadyInvoiced) {
            btn = `<button class="btn btn-primary btn-sm" onclick="confirmAdminPayment('${b.id}')">تأكيد التحويل</button>`;
        } else {
            btn = `<button class="btn btn-danger btn-sm" onclick="deleteAdminBooking('${b.id}')">حذف</button>`;
        }
        let totalDisplayPrice = b.totalAmount || (b.price + (b.shippingCost || 0));
        let detailsText = `${b.itemName} ${b.type === 'حجز منتجات' ? `<br><small>(${b.deliveryTypeName}) - ${b.address}</small>` : ''}`;
        html += `<tr><td>${b.customerName}</td><td><strong>${b.bookingNumber}</strong></td><td>${b.branchId === 'dokki' ? 'فرع الدواجن' : 'فرع الحدائق'}</td><td>${detailsText}</td><td><strong>${totalDisplayPrice} ج</strong></td><td><span class="badge">${b.paymentStatus}</span></td><td>${btn}</td></tr>`;
    });
    html += `</tbody></table>`;
    container.innerHTML = html;
}

function confirmAdminPayment(bookingId) {
    const b = appData.bookings.find(item => item.id === bookingId);
    if (b) {
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
    if (confirm('حذف الحجز؟')) {
        appData.bookings = appData.bookings.filter(b => b.id !== bookingId);
        saveData();
        renderAdminPaymentsTable();
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
    if (confirm('تحذير: هل تريد حقاً مسح وتصفير كل الفواتير والإيرادات بالكامل لأجل البدء على نظافة؟')) {
        appData.invoices = [];
        saveData();
        alert('تم مسح جميع الفواتير وتصفير الإيرادات بنجاح!');
        loadNosaOverview();
    }
}

function closeBranchDay(branchId) {
    const bName = branchId === 'dokki' ? 'فرع الدواجن' : 'فرع الحدائق';
    let todayStr = new Date().toLocaleDateString('ar-EG');
    if (confirm(`هل تريد عمل تقفيل اليوم لـ ${bName}؟`)) {
        if (!appData.closedDays) appData.closedDays = [];
        appData.closedDays.push({ branchId, date: todayStr, closedAt: new Date().toLocaleTimeString('ar-EG') });
        saveData();
        alert('تم التقفيل بنجاح!');
        loadNosaOverview();
    }
}
```[cite: 6]
