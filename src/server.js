function renderAdmin(){
if (S.loading) return `<div style="text-align:center;padding:3rem;"><div class="pbigspinner"></div><p class="pmuted" style="margin-top:1rem;">Loading data…</p></div>`;
const all=S.adminAppts;
const users=S.adminUsers;
const techs=S.adminTechs;
const counts={pending:all.filter(a=>a.status==='pending').length,approved:all.filter(a=>a.status==='approved').length,completed:all.filter(a=>a.status==='completed').length,declined:all.filter(a=>a.status==='declined').length,alt:all.filter(a=>a.status==='alt_proposed').length,emergency:all.filter(a=>a.emergency&&a.status!=='completed'&&a.status!=='declined').length};
const t=S.adminTab;
const q=(S.adminSearch||'').toLowerCase();
const tabBar = `<div style="display:flex;gap:.3rem;flex-wrap:wrap;margin-bottom:1.3rem;">
${['pending','approved','completed','declined','all','accounts','members','technicians','pricing','fleet','towing','finance'].map(tb=>{
const pendingVerifyCount = tb==='technicians' ? Object.values(techs).filter(t=>(t.verificationStatus||'pending')==='pending' && (t.idDocUrl||t.insuranceDocUrl||t.aseCertUrl||t.equipmentPhotoUrl)).length : 0;
return `<button class="ptab ${t===tb?'active':''}" data-atab="${tb}" style="text-transform:capitalize;">${tb}${['pending','approved','completed','declined'].includes(tb)?` (${counts[tb]||0})`:''}${tb==='pending'&&counts.alt>0?` +${counts.alt} alt`:''}${tb==='pending'&&counts.emergency>0?` 🚨${counts.emergency}`:''}${pendingVerifyCount>0?` 🔍${pendingVerifyCount}`:''}</button>`;
}).join('')}
</div>`;
let body='';
if (['pending','approved','completed','declined','all'].includes(t)) {
const filtered = all.filter(a=>{
const ms=t==='all'||a.status===t||(t==='pending'&&a.status==='alt_proposed');
const mq=!q||[a.name,a.serviceName,a.make,a.model,a.year,a.location].join(' ').toLowerCase().includes(q);
return ms&&mq;
}).sort((a,b)=> (b.emergency?1:0)-(a.emergency?1:0) || new Date(b.createdAt)-new Date(a.createdAt));
body=`
<div style="margin-bottom:1.1rem;"><input class="pinp" id="p-asearch" placeholder="Search name, vehicle, service…" value="${esc(S.adminSearch||'')}" style="max-width:340px;"></div>
${filtered.length===0?`<div class="pcard" style="text-align:center;padding:2rem;color:rgba(245,240,232,.25);">No ${t} appointments.</div>`
:filtered.map(a=>{
const noteVal=S.adminNotes[a.id]!==undefined?S.adminNotes[a.id]:(a.adminNote||'');
const altDate=S.adminAltDate[a.id]||'';
const altTime=S.adminAltTime[a.id]||'';
const techName = a.technicianId ? (techs[a.technicianId]?.name || 'Unknown Tech') : null;
return `<div class="pcard ${a.emergency?'red':''}" style="border-color:${a.emergency?'':a.status==='pending'||a.status==='alt_proposed'?'rgba(234,179,8,.3)':C.goldBorder};">
<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap;margin-bottom:.9rem;">
<div>
<div style="display:flex;align-items:center;gap:.55rem;flex-wrap:wrap;margin-bottom:.2rem;">
${a.emergency?`<span class="pbadge emergency">🚨 EMERGENCY</span>`:''}
<span style="font-weight:700;">${esc(a.name)}</span>
${a.rush?`<span style="background:rgba(220,38,38,.15);border:1px solid rgba(220,38,38,.3);color:#f87171;font-size:.68rem;font-weight:700;padding:.14rem .5rem;border-radius:100px;">⚡ RUSH</span>`:''}
${a.userId&&users[a.userId]?.membership?`<span class="pmember-badge">👑 MEMBER</span>`:''}
${techName?`<span style="background:rgba(59,130,246,.15);border:1px solid rgba(59,130,246,.3);color:#93c5fd;font-size:.68rem;font-weight:700;padding:.14rem .5rem;border-radius:100px;">🔧 ${esc(techName)}</span>`:(a.status==='approved'?`<span style="background:rgba(251,191,36,.12);border:1px solid rgba(251,191,36,.3);color:#fbbf24;font-size:.68rem;font-weight:700;padding:.14rem .5rem;border-radius:100px;">UNCLAIMED</span>`:'')}
</div>
<div style="font-weight:700;color:${C.gold};margin-bottom:.1rem;">${esc(a.serviceName)}</div>
<div class="pmuted">${esc(a.year)} ${esc(a.make)} ${esc(a.model)} · ${fmtDate(a.date)} at ${esc(a.time)}</div>
</div>
<span class="pbadge ${a.status}">${a.status.replace('_',' ').toUpperCase()}</span>
</div>
<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:.3rem 1.1rem;font-size:.8rem;margin-bottom:.8rem;">
${[['Phone',a.phone],['Email',a.email||'—'],['Location',a.location],['Est. Price',a.estimatedPrice?money(a.estimatedPrice):'TBD'],['Parts',a.partsChoice==='own'?'Customer supplies':a.partsChoice==='order'?'We order':'N/A']].map(([k,v])=>`<div style="display:flex;gap:.3rem;"><span class="pmuted">${k}:</span><span style="font-weight:500;">${esc(v)}</span></div>`).join('')}
</div>
${a.repairDesc?`<div style="padding:.55rem .85rem;background:rgba(255,255,255,.03);border-radius:6px;font-size:.81rem;color:rgba(245,240,232,.65);margin-bottom:.8rem;font-style:italic;border-left:2px solid ${C.goldBorder};">Customer: "${esc(a.repairDesc)}"</div>`:''}
${a.notes?`<div class="pmuted" style="font-size:.8rem;font-style:italic;margin-bottom:.7rem;">Notes: ${esc(a.notes)}</div>`:''}
${a.rating?`<div style="margin-bottom:.7rem;"><span class="pstars">${stars(a.rating)}</span>${a.ratingComment?` <span class="pmuted" style="font-size:.8rem;">"${esc(a.ratingComment)}"</span>`:''}</div>`:''}
<div style="margin-bottom:.85rem;"><label class="plbl">Message to Customer</label><input class="pinp" data-anote="${esc(a.id)}" value="${esc(noteVal)}" placeholder="e.g. Confirmed for 10am, please keep vehicle accessible."></div>
${a.status==='pending'||a.status==='alt_proposed'?`
<div class="palt-box" style="margin-bottom:.85rem;">
<div style="font-size:.82rem;font-weight:700;color:#93c5fd;margin-bottom:.7rem;">📅 Suggest Alternative Time (optional)</div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:.7rem;">
<div><label class="plbl">Alt Date</label><input class="pinp" type="date" data-aalt-date="${esc(a.id)}" value="${esc(altDate)}" min="${todayStr()}" max="${maxDateStr()}"></div>
<div><label class="plbl">Alt Time</label><select class="pinp" data-aalt-time="${esc(a.id)}"><option value="">Select time</option>${TIME_SLOTS.map(t2=>`<option value="${t2}" ${altTime===t2?'selected':''}>${t2}</option>`).join('')}</select></div>
</div>
</div>`:''}
${(a.status==='approved'||a.status==='completed')?`<div style="background:rgba(10,10,15,.4);border:1px solid rgba(201,168,76,.15);border-radius:6px;padding:.6rem .8rem;margin-bottom:.7rem;">
<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem;">
<div style="font-size:.78rem;color:${C.muted};">⏱ ${fmtDuration(a.actualClockedSeconds||0)} clocked | Pay hrs: <span style="color:${C.gold};font-weight:600;">${a.useLaborOverride&&a.laborHoursOverride?a.laborHoursOverride:(a.laborHours||0)}h</span></div>
<label style="display:flex;align-items:center;gap:.3rem;font-size:.74rem;color:${C.muted};cursor:pointer;"><input type="checkbox" data-toggle-labor-override="${esc(a.id)}" ${a.useLaborOverride?'checked':''}> Override</label>
</div>
${a.useLaborOverride?`<div style="margin-top:.4rem;display:flex;gap:.4rem;"><input class="pinp" type="number" step="0.1" min="0" style="max-width:100px;" data-labor-override-val="${esc(a.id)}" value="${a.laborHoursOverride||a.laborHours||0}"><button class="pbtn sm" style="background:rgba(201,168,76,.15);color:${C.gold};border:1px solid rgba(201,168,76,.3);" data-save-labor-override="${esc(a.id)}">Save</button></div>`:''}
</div>`:''}
<div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;">
${a.status==='pending'||a.status==='alt_proposed'?`<button class="pbtn grn sm" data-approve="${esc(a.id)}">✓ Approve</button><button class="pbtn red sm" data-decline="${esc(a.id)}">✗ Decline</button><button class="pbtn sm" style="background:rgba(59,130,246,.2);color:#93c5fd;border:1px solid rgba(59,130,246,.3);" data-propose-alt="${esc(a.id)}">📅 Propose Alt Time</button>`:''}
${a.status==='approved'?`<button class="pbtn purp sm" data-complete="${esc(a.id)}">✓ Mark Complete & Pay Tech</button>`:''}
${a.status==='completed'?`<span style="font-size:.8rem;color:#4ade80;font-weight:600;">✓ Complete · ${a.servicePoints||0} pts awarded</span>`:''}
</div>
</div>`;
}).join('')}`;
}
else if (t==='accounts') {
const at = S.adminAccountType || 'customer';
body = `
<div class="pcard blue" style="margin-bottom:1.5rem;">
<div class="ph3" style="margin-bottom:1rem;">➕ Create Account Manually</div>
<p class="pmuted" style="font-size:.82rem;margin-bottom:1.2rem;">Set up any account type yourself — useful for phone bookings, VIP setup, or fixing a signup issue.</p>
<div class="pg4" style="margin-bottom:1.4rem;">
${[['customer','👤 Customer'],['fleet','🚐 Fleet'],['technician','🔧 Technician'],['tow','🚛 Tow Co.']].map(([type,label])=>`
<button class="ptab ${at===type?'active':''}" data-account-create-type="${type}" style="padding:.6rem;">${label}</button>
`).join('')}
</div>
${S.adminAccountErr?`<div class="perr">${esc(S.adminAccountErr)}</div>`:''}
${at==='customer'?`
<div class="pr2" style="margin-bottom:1rem;">
<div><label class="plbl">Full Name *</label><input class="pinp" id="ac-cust-name" placeholder="Jane Smith" value="${esc(S.newCustForm.name)}"></div>
<div><label class="plbl">Phone</label><input class="pinp" id="ac-cust-phone" placeholder="(512) 555-0100" value="${esc(S.newCustForm.phone)}"></div>
</div>
<div style="margin-bottom:1rem;"><label class="plbl">Email *</label><input class="pinp" id="ac-cust-email" type="email" placeholder="customer@email.com" value="${esc(S.newCustForm.email)}"></div>
<div style="margin-bottom:1rem;"><label class="plbl">Primary Vehicle (optional)</label><input class="pinp" id="ac-cust-vehicle" placeholder="2019 Ford F-150" value="${esc(S.newCustForm.vehicle)}"></div>
<div style="margin-bottom:1.2rem;"><label class="plbl">Password *</label><input class="pinp" id="ac-cust-pass" type="text" placeholder="Set a password" value="${esc(S.newCustForm.password)}"></div>
<button class="pbtn blue" id="p-create-customer">+ Create Customer Account</button>
`:''}
${at==='fleet'?`
<div style="margin-bottom:1rem;"><label class="plbl">Company Name *</label><input class="pinp" id="ac-fleet-company" placeholder="ABC HVAC Services" value="${esc(S.newFleetForm.companyName)}"></div>
<div class="pr2" style="margin-bottom:1rem;">
<div><label class="plbl">Contact Name *</label><input class="pinp" id="ac-fleet-contact" placeholder="Dispatch Manager" value="${esc(S.newFleetForm.contactName)}"></div>
<div><label class="plbl">Phone</label><input class="pinp" id="ac-fleet-phone" placeholder="(512) 555-0100" value="${esc(S.newFleetForm.phone)}"></div>
</div>
<div style="margin-bottom:1rem;"><label class="plbl">Email *</label><input class="pinp" id="ac-fleet-email" type="email" placeholder="dispatch@company.com" value="${esc(S.newFleetForm.email)}"></div>
<div style="margin-bottom:1.2rem;"><label class="plbl">Password *</label><input class="pinp" id="ac-fleet-pass" type="text" placeholder="Set a password" value="${esc(S.newFleetForm.password)}"></div>
<button class="pbtn blue" id="p-create-fleet">+ Create Fleet Account</button>
`:''}
${at==='technician'?`
<div class="pr2" style="margin-bottom:1rem;">
<div><label class="plbl">Technician Name *</label><input class="pinp" id="ac-tech-name" placeholder="John Smith" value="${esc(S.newTechForm.name)}"></div>
<div><label class="plbl">PIN (4+ digits) *</label><input class="pinp" id="ac-tech-pin" placeholder="1234" value="${esc(S.newTechForm.pin)}"></div>
</div>
<div class="pr2" style="margin-bottom:1.2rem;">
<div><label class="plbl">Email <span class="pmuted">(for notifications)</span></label><input class="pinp" id="ac-tech-email" type="email" placeholder="tech@email.com" value="${esc(S.newTechForm.email)}"></div>
<div><label class="plbl">Phone</label><input class="pinp" id="ac-tech-phone" placeholder="(512) 555-0100" value="${esc(S.newTechForm.phone)}"></div>
</div>
<button class="pbtn blue" id="p-create-tech">+ Create Technician Account</button>
`:''}
${at==='tow'?`
<div class="pr2" style="margin-bottom:1rem;">
<div><label class="plbl">Company Name *</label><input class="pinp" id="ac-tow-company" placeholder="ABC Towing" value="${esc(S.newTowForm.companyName)}"></div>
<div><label class="plbl">Contact Name *</label><input class="pinp" id="ac-tow-contact" placeholder="Dispatch" value="${esc(S.newTowForm.contactName)}"></div>
</div>
<div class="pr2" style="margin-bottom:1rem;">
<div><label class="plbl">Phone *</label><input class="pinp" id="ac-tow-phone" placeholder="(512) 555-0100" value="${esc(S.newTowForm.phone)}"></div>
<div><label class="plbl">Email <span class="pmuted">(for notifications)</span></label><input class="pinp" id="ac-tow-email" type="email" placeholder="dispatch@towco.com" value="${esc(S.newTowForm.email)}"></div>
</div>
<div style="margin-bottom:1.2rem;"><label class="plbl">PIN *</label><input class="pinp" id="ac-tow-pin" placeholder="1234" value="${esc(S.newTowForm.pin)}"></div>
<button class="pbtn orange" id="p-create-tow">+ Create Towing Partner Account</button>
`:''}
</div>
<p class="pmuted" style="font-size:.8rem;">Accounts created here behave identically to self-registered ones — the person can sign in immediately with the email/password or PIN you set.</p>`;
}
else if (t==='technicians') {
const allT = Object.values(techs).sort((a,b)=>(a.name||'').localeCompare(b.name||''));
body=`
<div class="pcard blue" style="margin-bottom:1.5rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:1rem;">
<span class="pmuted" style="font-size:.85rem;">To create a new technician account (with email/phone for notifications), use the <strong style="color:${C.gold};">Accounts</strong> tab.</span>
<button class="pbtn blue sm" data-atab="accounts">+ Create Technician →</button>
</div>
${(()=>{
const pendingVerify = allT.filter(t=>(t.verificationStatus||'pending')==='pending' && (t.idDocUrl||t.insuranceDocUrl||t.aseCertUrl||t.equipmentPhotoUrl));
if (pendingVerify.length===0) return '';
return `<div class="pcard red" style="margin-bottom:1.5rem;">
<div class="ph3" style="color:#fca5a5;margin-bottom:.3rem;">🔍 ${pendingVerify.length} Technician${pendingVerify.length>1?'s':''} Awaiting Verification Review</div>
<p class="pmuted" style="font-size:.82rem;">Documents submitted below — review links and approve or reject.</p>
</div>`;
})()}
<div class="ph3" >All Technicians (${allT.length})</div>
${allT.length===0?`<div class="pcard" style="text-align:center;padding:2rem;color:rgba(245,240,232,.25);">No technicians added yet.</div>`
:allT.map(tech=>{
const techJobs = all.filter(a=>a.technicianId===tech.id);
const activeJobs = techJobs.filter(a=>a.status==='approved').length;
const doneJobs = tech.jobsCompleted||0;
const rating = tech.avgRating||5;
const belowMin = (tech.ratingCount||0)>=CONFIG.MIN_RATINGS_FOR_GRADING && rating < CONFIG.MIN_TECH_RATING;
const vStatus = tech.verificationStatus||'pending';
const hasDocs = tech.idDocUrl||tech.insuranceDocUrl||tech.aseCertUrl||tech.equipmentPhotoUrl;
return `<div class="pcard ${belowMin?'red':vStatus==='pending'&&hasDocs?'blue':''}">
<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:1rem;margin-bottom:.6rem;">
<div>
<div style="font-weight:700;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;">
🔧 ${esc(tech.name)}
${tech.active===false?`<span class="pbadge declined">INACTIVE</span>`:`<span class="pbadge approved">ACTIVE</span>`}
<span class="pbadge ${vStatus==='verified'?'approved':vStatus==='rejected'?'declined':'pending'}">${vStatus.toUpperCase()}</span>
${belowMin?`<span class="pbadge emergency">⚠ LOW RATING</span>`:''}
</div>
<div class="pmuted" style="font-size:.8rem;"><span class="pstars">${stars(rating)}</span> ${rating.toFixed(1)} (${tech.ratingCount||0} ratings) · PIN: ${esc(tech.pin)}</div>
<div class="pmuted" style="font-size:.78rem;">${activeJobs} active · ${doneJobs} completed · Earned ${money(tech.totalEarned||0)} · Paid out ${money(tech.totalPaidOut||0)}</div>
${tech.vehicleYear||tech.vehicleMake?`<div class="pmuted" style="font-size:.78rem;">Vehicle: ${esc(tech.vehicleYear||'')} ${esc(tech.vehicleMake||'')} ${esc(tech.vehicleModel||'')}</div>`:''}
</div>
<div style="display:flex;gap:.4rem;flex-wrap:wrap;">
<button class="pbtn sm ${tech.active===false?'grn':'red'}" data-toggle-tech="${esc(tech.id)}">${tech.active===false?'Reactivate':'Deactivate'}</button>
</div>
</div>
${hasDocs?`
<div style="background:rgba(255,255,255,.03);border-radius:6px;padding:.8rem;margin-bottom:.7rem;">
<div class="plbl" style="margin-bottom:.5rem;">Submitted Verification Documents</div>
<div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:${vStatus==='pending'?'.8rem':'0'};">
${tech.idDocUrl?`<a href="${esc(tech.idDocUrl)}" target="_blank" class="ppill" style="text-decoration:none;">📄 ID</a>`:`<span class="ppill" style="opacity:.4;">📄 ID — missing</span>`}
${tech.insuranceDocUrl?`<a href="${esc(tech.insuranceDocUrl)}" target="_blank" class="ppill" style="text-decoration:none;">🛡️ Insurance</a>`:`<span class="ppill" style="opacity:.4;">🛡️ Insurance — missing</span>`}
${tech.aseCertUrl?`<a href="${esc(tech.aseCertUrl)}" target="_blank" class="ppill" style="text-decoration:none;">🎓 ASE Cert</a>`:`<span class="ppill" style="opacity:.4;">🎓 ASE Cert — missing</span>`}
${tech.equipmentPhotoUrl?`<a href="${esc(tech.equipmentPhotoUrl)}" target="_blank" class="ppill" style="text-decoration:none;">🧰 Equipment Photo</a>`:`<span class="ppill" style="opacity:.4;">🧰 Equipment — missing</span>`}
</div>
${vStatus==='pending'?`<div style="display:flex;gap:.5rem;">
<button class="pbtn grn sm" data-verify-tech="${esc(tech.id)}" data-verify-action="verified">✓ Approve Verification</button>
<button class="pbtn red sm" data-verify-tech="${esc(tech.id)}" data-verify-action="rejected">✗ Reject</button><button class="pbtn sm" style="background:${tech.jobEligible!==false?'rgba(239,68,68,.15)':' rgba(74,222,128,.15)'};color:${tech.jobEligible!==false?'#f87171':'#4ade80'};border:1px solid ${tech.jobEligible!==false?'rgba(239,68,68,.3)':'rgba(74,222,128,.3)'};" data-toggle-eligible="${esc(tech.id)}">${tech.jobEligible!==false?'🚫 Ineligible':'✓ Restore'}</button>
</div>`:vStatus==='rejected'?`<button class="pbtn sm" style="background:rgba(234,179,8,.15);color:#fbbf24;border:1px solid rgba(234,179,8,.3);" data-verify-tech="${esc(tech.id)}" data-verify-action="pending">↺ Reset to Pending for Re-review</button>`:`<span style="font-size:.8rem;color:#4ade80;font-weight:600;">✓ Verified</span>`}
</div>`:`<div class="pmuted" style="font-size:.8rem;margin-bottom:.7rem;font-style:italic;">No verification documents submitted yet.</div>`}
<div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-top:.6rem;">
<span class="pmuted" style="font-size:.78rem;">Owed: ${money((tech.totalEarned||0)-(tech.totalPaidOut||0))}</span>
<input type="number" class="pinp" data-payout-amt="${esc(tech.id)}" placeholder="Amount" style="width:90px;padding:.35rem .5rem;font-size:.8rem;">
<button class="pbtn gold sm" data-payout-tech="${esc(tech.id)}">💸 Pay via Stripe</button>
${!tech.stripeConnectId?`<span class="pmuted" style="font-size:.74rem;color:#fbbf24;">⚠ Technician hasn't set up payouts yet</span>`:''}
</div>
</div>`;
}).join('')}`;
}
else if (t==='members') {
const allU=Object.values(users).sort((a,b)=>(b.points||0)-(a.points||0));
body=allU.length===0
?`<div class="pcard" style="text-align:center;padding:2rem;color:rgba(245,240,232,.25);">No members yet.</div>`
:allU.map(u=>{const ti=getTier(u.points||0);const mPts=S.manualPts[u.id]!==undefined?S.manualPts[u.id]:'25';return`<div class="pcard">
<div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:1rem;margin-bottom:.9rem;">
<div>
<div style="display:flex;align-items:center;gap:.55rem;margin-bottom:.2rem;"><span style="font-size:1.1rem;">${ti.icon}</span><span style="font-weight:700;">${esc(u.name)}</span><span style="font-size:.75rem;color:${ti.color};font-weight:600;">${ti.name}</span>${u.membership?`<span class="pmember-badge">👑 MEMBER</span>`:''}</div>
<div class="pmuted" style="font-size:.8rem;">${esc(u.email)} · ${esc(u.phone||'No phone')}</div>
<div class="pmuted" style="font-size:.77rem;">Joined ${new Date(u.joinedAt).toLocaleDateString()} · ${u.bookings?.length||0} booking(s)</div>
</div>
<div style="text-align:right;"><div style="font-size:1.7rem;font-family:Georgia,serif;font-weight:700;color:${C.gold};">${(u.points||0).toLocaleString()}</div><div class="pmuted">points</div></div>
</div>
<div style="display:flex;gap:.5rem;align-items:center;"><input type="number" class="pinp" data-mpts-inp="${esc(u.id)}" value="${esc(mPts)}" min="1" style="width:68px;padding:.35rem .5rem;font-size:.82rem;"><button class="pbtn gold sm" data-award="${esc(u.id)}">+ Award Points</button></div>
</div>`;}).join('');
}
else if (t==='pricing') {
const allP = Object.values(S.adminPricing).sort((a,b)=>(a.service||'').localeCompare(b.service||''));
body=`
<div class="pcard blue" style="margin-bottom:1.2rem;">
<p style="font-size:.85rem;">Edit labor hours, hourly rate, and average parts cost for each service. These drive the instant price estimate customers see when booking.</p>
</div>
${allP.map(p=>{
const isDiag = p.id.startsWith('diag_');
const edit = S.pricingEdits[p.id] || {};
return `<div class="pcard">
<div class="ph3" >${esc(p.service)}${isDiag?` <span class="ppill">Flat $${CONFIG.DIAGNOSTIC_FLAT_FEE} — not editable here</span>`:''}</div>
${!isDiag?`
<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:.8rem;">
<div><label class="plbl">Labor Hours</label><input type="number" step="0.25" class="pinp" data-price-labor="${esc(p.id)}" value="${edit.baseLaborHours??p.baseLaborHours}"></div>
<div><label class="plbl">Hourly Rate ($)</label><input type="number" class="pinp" data-price-rate="${esc(p.id)}" value="${edit.hourlyRate??p.hourlyRate}"></div>
<div><label class="plbl">Avg Parts Cost ($)</label><input type="number" class="pinp" data-price-parts="${esc(p.id)}" value="${edit.avgPartsCost??p.avgPartsCost}"></div>
</div>
<button class="pbtn gold sm" data-save-pricing="${esc(p.id)}" style="margin-top:.8rem;">Save</button>`:''}
</div>`;
}).join('')}`;
}
else if (t==='fleet') {
const cos = Object.values(S.adminFleetCos);
const vehicles = S.adminFleetVehicles;
body = cos.length===0
? `<div class="pcard" style="text-align:center;padding:2rem;color:rgba(245,240,232,.25);">No fleet accounts yet.</div>`
: cos.map(co=>{
const coVehicles = Object.values(vehicles).filter(v=>v.companyId===co.id);
const coJobs = all.filter(a=>a.fleetCompanyId===co.id);
return `<div class="pcard">
<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:1rem;margin-bottom:.6rem;">
<div>
<div style="font-weight:700;">🚐 ${esc(co.companyName)} ${co.monthlyPlan?`<span class="pbadge approved">MONTHLY PLAN</span>`:''}</div>
<div class="pmuted" style="font-size:.8rem;">${esc(co.contactName)} · ${esc(co.email)} · ${esc(co.phone||'No phone')}</div>
<div class="pmuted" style="font-size:.78rem;">${coVehicles.length} vehicle(s) · ${coJobs.length} job(s)</div>
</div>
</div>
<div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;">
<input type="number" class="pinp" data-fleet-plan-price="${esc(co.id)}" placeholder="Monthly $" value="${co.monthlyPlanPrice||''}" style="width:110px;padding:.4rem .6rem;font-size:.82rem;">
<button class="pbtn blue sm" data-fleet-toggle-plan="${esc(co.id)}">${co.monthlyPlan?'Disable Plan':'Enable Monthly Plan'}</button>
</div>
</div>`;
}).join('');
}
else if (t==='towing') {
const towCos = Object.values(S.adminTowCos);
const towReqs = Object.values(S.adminTowReqs).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
body=`
<div class="pcard orange" style="margin-bottom:1.5rem;">
<div class="ph3" style="margin-bottom:1rem;">➕ Add Towing Partner</div>
${S.newTowErr?`<div class="perr">${esc(S.newTowErr)}</div>`:''}
<div class="pr2" >
<div><label class="plbl">Company Name</label><input class="pinp" id="ntw-company" placeholder="ABC Towing" value="${esc(S.newTowForm.companyName)}"></div>
<div><label class="plbl">Contact Name</label><input class="pinp" id="ntw-contact" placeholder="Dispatch" value="${esc(S.newTowForm.contactName)}"></div>
</div>
<div class="pr2" style="margin-bottom:1rem;">
<div><label class="plbl">Phone</label><input class="pinp" id="ntw-phone" placeholder="(512) 555-0100" value="${esc(S.newTowForm.phone)}"></div>
<div><label class="plbl">PIN</label><input class="pinp" id="ntw-pin" placeholder="1234" value="${esc(S.newTowForm.pin)}"></div>
</div>
<button class="pbtn orange" id="p-add-tow">+ Add Towing Partner</button>
</div>
<div class="ph3" >Towing Partners (${towCos.length})</div>
${towCos.map(co=>`<div class="pcard" >
<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:1rem;">
<div><strong>🚛 ${esc(co.companyName)}</strong> ${co.active===false?`<span class="pbadge declined">INACTIVE</span>`:`<span class="pbadge approved">ACTIVE</span>`}<div class="pmuted" style="font-size:.8rem;">${esc(co.contactName)} · ${esc(co.phone)} · PIN: ${esc(co.pin)}</div></div>
<button class="pbtn sm ${co.active===false?'grn':'red'}" data-toggle-tow="${esc(co.id)}">${co.active===false?'Reactivate':'Deactivate'}</button>
</div>
</div>`).join('')}
<div class="pdiv"></div>
<div class="ph3" >Tow Requests (${towReqs.length})</div>
${towReqs.length===0?`<div class="pcard" style="text-align:center;padding:1.5rem;color:rgba(245,240,232,.25);">No tow requests yet.</div>`
:towReqs.map(r=>`<div class="pcard">
<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap;">
<div><strong>${esc(r.customerName)}</strong> · ${esc(r.phone)}<div class="pmuted" style="font-size:.8rem;">${esc(r.vehicle||'Vehicle N/A')} · Pickup: ${esc(r.pickupLocation)}</div></div>
<span class="pbadge ${r.status==='claimed'?'claimed':r.status}">${r.status.toUpperCase()}</span>
</div>
${r.towCompanyId?`<div class="pmuted" style="font-size:.8rem;margin-top:.4rem;">Claimed by: ${esc(S.adminTowCos[r.towCompanyId]?.companyName||'Unknown')}</div>`:''}
</div>`).join('')}`;
}
else if (t==='finance') {
body = renderFinanceTab(all, techs);
}
return `
<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.8rem;margin-bottom:.6rem;">
<span class="peye" style="margin-bottom:0;">Admin Panel</span>
<button class="pbtn ghost sm" id="p-refresh">↻ Refresh</button>
</div>
<div class="ph1" style="margin-bottom:1rem;">Upper Echelon Automotive — Management</div>
${counts.emergency>0?`<div class="pcard red" style="margin-bottom:1.2rem;"><strong style="color:#fca5a5;">🚨 ${counts.emergency} Emergency Job${counts.emergency>1?'s':''} Awaiting Action</strong></div>`:''}
<div class="pg4" style="margin-bottom:1.8rem;">
${[['Pending',counts.pending+counts.alt,'#fbbf24'],['Approved',counts.approved,'#4ade80'],['Completed',counts.completed,'#a78bfa'],['Members',Object.values(users).filter(u=>u.membership).length,C.gold],['Technicians',Object.keys(techs).length,'#3b82f6']].map(([l,v,c])=>`<div class="pcard pst"><div class="pst-num" style="color:${c};">${v}</div><div class="pmuted">${l}</div></div>`).join('')}
</div>
${tabBar}
${body}`;
}
function renderFinanceTab(all, techs) {
const range = S.financeRange;
const now = new Date();
const cutoff = new Date(now);
if (range==='week') cutoff.setDate(now.getDate()-7);
if (range==='month') cutoff.setMonth(now.getMonth()-1);
if (range==='year') cutoff.setFullYear(now.getFullYear()-1);
const completed = all.filter(a=>a.status==='completed' && a.completedAt && new Date(a.completedAt)>=cutoff);
const grossRevenue = completed.reduce((sum,a)=>sum+(a.estimatedPrice||0),0);
const techPayout = completed.reduce((sum,a)=>sum+calcTechPayout(a),0);
const businessRetained = grossRevenue - techPayout;
const owedByTech = {};
Object.values(techs).forEach(t=>{ owedByTech[t.id] = (t.totalEarned||0)-(t.totalPaidOut||0); });
const totalOwed = Object.values(owedByTech).reduce((s,v)=>s+v,0);
return `
<div style="display:flex;gap:.4rem;margin-bottom:1.3rem;">
${['week','month','year'].map(r=>`<button class="ptab ${range===r?'active':''}" data-finance-range="${r}" style="text-transform:capitalize;">This ${r}</button>`).join('')}
</div>
<div class="pg3" style="margin-bottom:1.5rem;">
<div class="pcard gold"><div class="ph3">Gross Revenue</div><div style="font-size:2rem;font-family:Georgia,serif;font-weight:700;color:${C.gold};">${money(grossRevenue)}</div><div class="pmuted">${completed.length} completed job(s)</div></div>
<div class="pcard blue"><div class="ph3">Technician Payout (${CONFIG.TECH_PAYOUT_PCT}%)</div><div style="font-size:2rem;font-family:Georgia,serif;font-weight:700;color:#3b82f6;">${money(techPayout)}</div><div class="pmuted">What techs earned this period</div></div>
<div class="pcard"><div class="ph3">Business Retained (${100-CONFIG.TECH_PAYOUT_PCT}%)</div><div style="font-size:2rem;font-family:Georgia,serif;font-weight:700;color:#4ade80;">${money(businessRetained)}</div><div class="pmuted">Your take this period</div></div>
</div>
<div class="pcard red" style="margin-bottom:1.5rem;">
<div class="ph3" style="color:#fca5a5;">⚠ Total Owed to Technicians (All-Time)</div>
<div style="font-size:1.8rem;font-family:Georgia,serif;font-weight:700;color:#fca5a5;">${money(totalOwed)}</div>
<p class="pmuted" style="font-size:.8rem;margin-top:.4rem;">Pay out from the Technicians tab. Tracked per-technician.</p>
</div>
<div class="ph3" >Revenue by Service (${range})</div>
${(()=>{ const bySvc={}; completed.forEach(a=>{ bySvc[a.serviceName]=(bySvc[a.serviceName]||0)+(a.estimatedPrice||0); });
const rows = Object.entries(bySvc).sort((a,b)=>b[1]-a[1]);
return rows.length===0 ? `<div class="pcard" style="text-align:center;color:rgba(245,240,232,.25);">No completed jobs in this period.</div>`
: rows.map(([svc,amt])=>`<div class="pcard"><div style="display:flex;justify-content:space-between;"><span>${esc(svc)}</span><strong style="color:${C.gold};">${money(amt)}</strong></div></div>`).join('');
})()}`;
}
function renderTechPortal(){
if (S.loading) return `<div style="text-align:center;padding:3rem;"><div class="pbigspinner"></div><p class="pmuted" style="margin-top:1rem;">Loading jobs…</p></div>`;
const tech = S.tech;
const techFull = S.techAllTechs[tech.id] || {};
const allAppts = S.techAllAppts;
const declines = Data.getTechDeclines(tech.id);
const available = allAppts.filter(a => a.status==='approved' && !a.technicianId && !declines.includes(a.id)).sort((a,b)=>(b.emergency?1:0)-(a.emergency?1:0));
const myJobs = allAppts.filter(a => a.technicianId === tech.id);
const myActive = myJobs.filter(a => a.status==='approved');
const myDone = myJobs.filter(a => a.status==='completed');
const rating = techFull.avgRating||5;
const vStatus = techFull.verificationStatus||'pending';
const owed = (techFull.totalEarned||0)-(techFull.totalPaidOut||0);
const t = S.techTab;
let body = '';
if (t==='available') {
body = available.length===0
? `<div class="pcard" style="text-align:center;padding:2.5rem;"><div style="font-size:3rem;margin-bottom:.8rem;">📭</div><div class="ph3">No available jobs right now</div><div class="pmuted">Check back soon — new approved jobs appear here.</div></div>`
: available.map(a=>`<div class="pcard ${a.emergency?'red':'blue'}">
<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap;margin-bottom:.8rem;">
<div>
${a.emergency?`<span class="pbadge emergency" style="margin-bottom:.3rem;display:inline-block;">🚨 EMERGENCY</span><br>`:''}
<div style="font-weight:700;color:${C.gold};margin-bottom:.15rem;">${esc(a.serviceName)}${a.rush?` <span style="background:rgba(220,38,38,.15);border:1px solid rgba(220,38,38,.3);color:#f87171;font-size:.65rem;font-weight:700;padding:.12rem .45rem;border-radius:100px;margin-left:.4rem;">⚡ RUSH</span>`:''}</div>
<div class="pmuted">${esc(a.year)} ${esc(a.make)} ${esc(a.model)}</div>
<div class="pmuted">${fmtDate(a.date)} at ${esc(a.time)}</div>
</div>
<span class="ppill">Est: ${money(a.estimatedPrice||0)} · You earn ${money(calcTechPayout(a))}</span>
</div>
<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:.3rem 1rem;font-size:.8rem;margin-bottom:.8rem;">
${[['Location',a.location],['Phone',a.phone],['Parts',a.partsChoice==='own'?'Customer has parts':a.partsChoice==='order'?'You bring parts':'N/A']].map(([k,v])=>`<div style="display:flex;gap:.3rem;"><span class="pmuted">${k}:</span><span style="font-weight:500;">${esc(v)}</span></div>`).join('')}
</div>
${a.repairDesc?`<div style="padding:.55rem .85rem;background:rgba(255,255,255,.03);border-radius:6px;font-size:.81rem;color:rgba(245,240,232,.65);margin-bottom:.9rem;font-style:italic;">Customer: "${esc(a.repairDesc)}"</div>`:''}
<div style="display:flex;gap:.5rem;">
<button class="pbtn grn" data-tech-accept="${esc(a.id)}">✓ Accept Job</button>
<button class="pbtn ghost sm" data-tech-decline="${esc(a.id)}">✗ Not for me</button>
</div>
</div>`).join('');
}
if (t==='myjobs') {
body = myActive.length===0
? `<div class="pcard" style="text-align:center;padding:2.5rem;"><div style="font-size:3rem;margin-bottom:.8rem;">🔧</div><div class="ph3">No active jobs</div><button class="pbtn blue" data-tech-tab="available" style="margin-top:1rem;">Browse Available Jobs</button></div>`
: myActive.sort((a,b)=>new Date(a.date)-new Date(b.date)).map(a=>`<div class="pcard ${a.emergency?'red':''}">
${a.emergency?`<span class="pbadge emergency" style="margin-bottom:.5rem;display:inline-block;">🚨 EMERGENCY</span>`:''}
<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap;margin-bottom:.7rem;">
<div>
<div style="font-weight:700;color:${C.gold};margin-bottom:.15rem;">${esc(a.serviceName)}</div>
<div class="pmuted">${esc(a.year)} ${esc(a.make)} ${esc(a.model)}</div>
<div class="pmuted">${fmtDate(a.date)} at ${esc(a.time)}</div>
</div>
<span class="ppill">You earn ${money(calcTechPayout(a))}</span>
</div>
<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:.3rem 1rem;font-size:.8rem;margin-bottom:.8rem;">
${[['Customer',a.name],['Phone',a.phone],['Location',a.location]].map(([k,v])=>`<div style="display:flex;gap:.3rem;"><span class="pmuted">${k}:</span><span style="font-weight:500;">${esc(v)}</span></div>`).join('')}
</div>
${a.repairDesc?`<div style="padding:.55rem .85rem;background:rgba(255,255,255,.03);border-radius:6px;font-size:.81rem;color:rgba(245,240,232,.65);margin-bottom:.8rem;font-style:italic;">"${esc(a.repairDesc)}"</div>`:''}
<div style="background:rgba(10,10,15,.5);border:1px solid rgba(201,168,76,.2);border-radius:6px;padding:.6rem .8rem;margin-bottom:.7rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem;">
<div style="font-size:.78rem;color:${C.muted};">⏱ <span style="color:${C.cream};font-weight:600;">${fmtDuration(a.actualClockedSeconds||0)}</span></div>
${S.activeClockLog&&S.activeClockLog.appointment_id===a.id?`<button class="pbtn red sm" data-clock-stop="${esc(a.id)}">⏸ Clock Out</button>`:`<button class="pbtn grn sm" data-clock-start="${esc(a.id)}" ${S.activeClockLog?'disabled':''}>▶ Clock In</button>`}
</div>
<div style="display:flex;gap:.5rem;flex-wrap:wrap;">
<a href="tel:${esc(a.phone)}" class="pbtn ghost sm" style="text-decoration:none;">📞 Call Customer</a>
<a href="https://maps.google.com/?q=${encodeURIComponent(a.location)}" target="_blank" class="pbtn ghost sm" style="text-decoration:none;">🗺️ Directions</a>
</div>
</div>`).join('');
}
if (t==='schedule') { body = renderTechSchedule(myJobs); }
if (t==='earnings') {
const allCompletedByTech = myDone;
const totalEarned = techFull.totalEarned||0;
const totalPaid = techFull.totalPaidOut||0;
body = `
<div class="pg3" style="margin-bottom:1.5rem;">
<div class="pcard gold"><div class="ph3">Total Earned</div><div style="font-size:1.8rem;font-family:Georgia,serif;font-weight:700;color:${C.gold};">${money(totalEarned)}</div></div>
<div class="pcard"><div class="ph3">Paid Out</div><div style="font-size:1.8rem;font-family:Georgia,serif;font-weight:700;color:#4ade80;">${money(totalPaid)}</div></div>
<div class="pcard blue"><div class="ph3">Currently Owed</div><div style="font-size:1.8rem;font-family:Georgia,serif;font-weight:700;color:#3b82f6;">${money(owed)}</div></div>
</div>
<div class="pcard ${S.techConnectStatus?.payoutsEnabled?'gold':'blue'}">
<div class="ph3" style="margin-bottom:1rem;">💳 Payout Setup (Stripe)</div>
${S.techConnectStatus?.payoutsEnabled?`
<p style="font-size:.85rem;color:${C.gold};font-weight:700;margin-bottom:.5rem;">✓ Payouts are set up and active</p>
<p class="pmuted" style="font-size:.82rem;">Robert can now pay you directly to your bank account when he marks a job complete.</p>
`:S.techConnectStatus?.connected?`
<p style="font-size:.85rem;color:#fbbf24;font-weight:700;margin-bottom:.5rem;">⏳ Setup started but not finished</p>
<p class="pmuted" style="font-size:.82rem;margin-bottom:1rem;">You started Stripe onboarding but haven't completed it yet.</p>
<button class="pbtn blue sm" id="p-tech-onboard">Finish Payout Setup →</button>
`:`
<p class="pmuted" style="font-size:.82rem;margin-bottom:1rem;">Set up direct deposit so Robert can pay you instantly when a job is marked complete. Takes about 5 minutes — Stripe will ask for your bank account and ID.</p>
<button class="pbtn blue" id="p-tech-onboard">Set Up Payouts →</button>
`}
${S.paymentErr?`<div class="perr" style="margin-top:1rem;">${esc(S.paymentErr)}</div>`:''}
</div>
<div class="pdiv"></div>
<div class="ph3" >Service History (${allCompletedByTech.length})</div>
${allCompletedByTech.length===0?`<div class="pcard" style="text-align:center;color:rgba(245,240,232,.25);">No completed jobs yet.</div>`
:allCompletedByTech.sort((a,b)=>new Date(b.completedAt||b.date)-new Date(a.completedAt||a.date)).map(a=>`<div class="pcard">
<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap;">
<div><div style="font-weight:700;">${esc(a.serviceName)}</div><div class="pmuted" style="font-size:.8rem;">${esc(a.year)} ${esc(a.make)} ${esc(a.model)} · ${fmtDate(a.date)}</div></div>
<div style="text-align:right;"><div style="font-weight:700;color:${C.gold};">${money(calcTechPayout(a))}</div>${a.rating?`<span class="pstars" style="font-size:.8rem;">${stars(a.rating)}</span>`:''}</div>
</div>
</div>`).join('')}`;
}
if (t==='profile') {
body = `
<div class="pcard">
<div class="ph3" style="margin-bottom:1rem;">📸 Profile Photo & Vehicle</div>
<div class="pr2" style="margin-bottom:1rem;">
<div><label class="plbl">Profile Photo URL</label><input class="pinp" id="tp-photo" placeholder="https://... (paste image link)" value="${esc(techFull.photoUrl||'')}"></div>
<div></div>
</div>
<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:.8rem;margin-bottom:1rem;">
<div><label class="plbl">Vehicle Year</label><input class="pinp" id="tp-vyear" value="${esc(techFull.vehicleYear||'')}"></div>
<div><label class="plbl">Vehicle Make</label><input class="pinp" id="tp-vmake" value="${esc(techFull.vehicleMake||'')}"></div>
<div><label class="plbl">Vehicle Model</label><input class="pinp" id="tp-vmodel" value="${esc(techFull.vehicleModel||'')}"></div>
</div>
<button class="pbtn gold sm" id="p-save-profile">Save Profile</button>
</div>
<div class="pcard ${vStatus==='verified'?'gold':'red'}">
<div class="ph3" style="margin-bottom:.3rem;">✅ Verification — Status: <span style="color:${vStatus==='verified'?C.gold:'#fca5a5'};text-transform:uppercase;">${vStatus}</span></div>
<p class="pmuted" style="font-size:.82rem;margin-bottom:1rem;">Paste links to your documents (Google Drive, Dropbox, etc — set to "anyone with link can view"). Robert will review and verify.</p>
<div style="display:grid;gap:.8rem;">
<div><label class="plbl">Government-Issued ID</label><input class="pinp" id="tp-iddoc" placeholder="https://drive.google.com/..." value="${esc(techFull.idDocUrl||'')}"></div>
<div><label class="plbl">Vehicle Insurance</label><input class="pinp" id="tp-insdoc" placeholder="https://drive.google.com/..." value="${esc(techFull.insuranceDocUrl||'')}"></div>
<div><label class="plbl">ASE Certification</label><input class="pinp" id="tp-asecert" placeholder="https://drive.google.com/..." value="${esc(techFull.aseCertUrl||'')}"></div>
<div><label class="plbl">Equipment Photo</label><input class="pinp" id="tp-equip" placeholder="https://drive.google.com/..." value="${esc(techFull.equipmentPhotoUrl||'')}"></div>
</div>
<button class="pbtn gold sm" id="p-save-verification" style="margin-top:1rem;">Submit for Verification</button>
</div>
<div class="pcard">
<div class="ph3" style="margin-bottom:.5rem;">📍 Location Sharing</div>
<p class="pmuted" style="font-size:.82rem;margin-bottom:1rem;">Share your live location so customers can see how far away you are during active jobs.</p>
<button class="pbtn blue sm" id="p-share-location">📍 Update My Location Now</button>
${techFull.locationUpdatedAt?`<p class="pmuted" style="font-size:.76rem;margin-top:.6rem;">Last updated: ${new Date(techFull.locationUpdatedAt).toLocaleString()}</p>`:''}
</div>`;
}
return `
<div style="display:flex;align-items:center;gap:1rem;margin-bottom:1.6rem;flex-wrap:wrap;">
<div class="pavatar">${techFull.photoUrl?`<img src="${esc(techFull.photoUrl)}" alt="">`:esc(tech.name.charAt(0))}</div>
<div>
<span class="peye">Technician Portal</span>
<div class="ph1">Welcome, ${esc(tech.name)}</div>
<div style="display:flex;align-items:center;gap:.6rem;"><span class="pstars">${stars(rating)}</span><span class="pmuted">${rating.toFixed(1)} (${techFull.ratingCount||0} ratings)</span><span class="pbadge ${vStatus==='verified'?'approved':'pending'}">${vStatus.toUpperCase()}</span></div>
</div>
</div>
<div class="pstgrid">
${[['Available Jobs',available.length],['Active Jobs',myActive.length],['Completed',techFull.jobsCompleted||0],['Owed to You',money(owed)]].map(([l,v])=>`<div class="pcard pst"><div class="pst-num" style="font-size:1.5rem;">${v}</div><div class="pmuted">${l}</div></div>`).join('')}
</div>
<div style="display:flex;gap:.3rem;margin-bottom:1.8rem;border-bottom:1px solid rgba(201,168,76,.12);flex-wrap:wrap;">
${[['available','Available Jobs'],['myjobs','My Jobs'],['schedule','My Schedule'],['earnings','Earnings & History'],['profile','Profile & Verification']].map(([tb,lbl])=>`<button class="ptab ${S.techTab===tb?'blue active':''}" data-tech-tab="${tb}" style="border-radius:6px 6px 0 0;padding-bottom:.7rem;">${lbl}</button>`).join('')}
</div>
${body}`;
}
function renderTechSchedule(myJobs) {
const month = S.techScheduleMonth;
const year = month.getFullYear();
const mo = month.getMonth();
const firstDay = new Date(year, mo, 1);
const lastDay = new Date(year, mo+1, 0);
const startWeekday = firstDay.getDay();
const daysInMonth = lastDay.getDate();
const monthName = month.toLocaleDateString('en-US',{month:'long',year:'numeric'});
const jobsByDate = {};
myJobs.filter(a=>a.status==='approved'||a.status==='completed').forEach(a=>{
if (!jobsByDate[a.date]) jobsByDate[a.date]=[];
jobsByDate[a.date].push(a);
});
const cells = [];
for (let i=0;i<startWeekday;i++) cells.push(null);
for (let d=1;d<=daysInMonth;d++) cells.push(d);
const todayIso = todayStr();
return `
<div class="pcard">
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.2rem;">
<button class="pbtn ghost sm" id="p-cal-prev">← Prev</button>
<div class="ph3" style="margin-bottom:0;">${monthName}</div>
<button class="pbtn ghost sm" id="p-cal-next">Next →</button>
</div>
<div class="pcal">
${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d=>`<div class="pcal-hdr">${d}</div>`).join('')}
${cells.map(d=>{
if (!d) return `<div class="pcal-day empty"></div>`;
const dateStr = `${year}-${String(mo+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
const jobs = jobsByDate[dateStr]||[];
const isToday = dateStr===todayIso;
return `<div class="pcal-day ${isToday?'today':''}">
<div class="pcal-daynum">${d}</div>
${jobs.map(j=>`<div class="pcal-job" data-job-detail="${esc(j.id)}" title="${esc(j.serviceName)} — ${esc(j.time)}">${esc(j.time.replace(' ',''))} ${esc(j.make)}</div>`).join('')}
</div>`;
}).join('')}
</div>
</div>
<p class="pmuted" style="font-size:.8rem;">Showing your accepted jobs. Tap a job on the calendar to view full details in "My Jobs".</p>`;
}
function renderFleetPortal(){
if(S.loading)return`<div style="text-align:center;padding:3rem;"><div class="pbigspinner"></div><p class="pmuted" style="margin-top:1rem;">Loading fleet data…</p></div>`;
const fleet=S.fleet;const vehicles=S.fleetVehicles||[];const appts=S.fleetAppts||[];const sub=S.fleetSub;const t=S.fleetTab||'vehicles';
const planName=sub?sub.plan_name:'No active plan';
const hoursUsed=sub?Number(sub.hours_used_this_period||0):0;
const hoursCap=sub?Number(sub.labor_hours_cap_per_vehicle||3)*vehicles.length:0;
let body='';
if(t==='vehicles'){
const planLimit=sub?Number(sub.vehicle_limit):999;
const atLimit=sub&&vehicles.length>=planLimit;
body=`${atLimit?`<div class="pcard" style="background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.25);margin-bottom:1rem;"><p style="color:#f87171;font-size:.85rem;margin:0;">Vehicle limit reached for ${esc(planName)} (${planLimit} max). Upgrade to add more.</p></div>`:''}
<div class="pcard blue" style="margin-bottom:1.5rem;">
<div class="ph3" style="margin-bottom:.8rem;">Add Vehicle</div>
${S.fleetVehicleErr?`<div class="perr" style="margin-bottom:.6rem;">${esc(S.fleetVehicleErr)}</div>`:''}
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:.6rem;margin-bottom:.7rem;">
<div><label class="plbl">Year *</label><input class="pinp" id="nv-year" placeholder="2022" value="${esc(S.fleetVehicleForm?.year||'')}"></div>
<div><label class="plbl">Make *</label><input class="pinp" id="nv-make" placeholder="Ford" value="${esc(S.fleetVehicleForm?.make||'')}"></div>
<div><label class="plbl">Model *</label><input class="pinp" id="nv-model" placeholder="Transit" value="${esc(S.fleetVehicleForm?.model||'')}"></div>
<div><label class="plbl">Nickname</label><input class="pinp" id="nv-nick" placeholder="Van #3" value="${esc(S.fleetVehicleForm?.nickname||'')}"></div>
</div>
<div class="pr2" style="margin-bottom:.7rem;">
<div><label class="plbl">VIN (optional)</label><input class="pinp" id="nv-vin" placeholder="1FTBW3XM..." value="${esc(S.fleetVehicleForm?.vin||'')}"></div>
<div><label class="plbl">Mileage</label><input class="pinp" id="nv-mileage" type="number" placeholder="42000" value="${esc(S.fleetVehicleForm?.mileage||'')}"></div>
</div>
<button class="pbtn blue" id="p-add-vehicle" ${atLimit?'disabled':''}>+ Add Vehicle</button>
</div>
<div class="ph3">Your Fleet (${vehicles.length}${sub?'/'+planLimit:''})</div>
${vehicles.length===0?`<div class="pcard" style="text-align:center;padding:2rem;color:rgba(245,240,232,.25);">No vehicles added yet.</div>`
:vehicles.map(v=>{const vAppts=appts.filter(a=>a.fleetVehicleId===v.id);const last=vAppts.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt))[0];
return`<div class="pcard" style="margin-bottom:.6rem;"><div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.8rem;">
<div><strong>${esc(v.nickname||`${v.year} ${v.make} ${v.model}`)}</strong>
<div class="pmuted" style="font-size:.78rem;">${esc(v.year)} ${esc(v.make)} ${esc(v.model)}${v.vin?` · VIN: ${esc(v.vin)}`:''}${v.mileage?` · ${Number(v.mileage).toLocaleString()} mi`:''}</div>
<div class="pmuted" style="font-size:.76rem;">${vAppts.length} records${last?' · Last: '+fmtDate(last.date):''}</div></div>
<button class="pbtn gold sm" data-fleet-book-vehicle="${esc(v.id)}">Schedule Service</button>
</div></div>`;}).join('')}`;
}
if(t==='book'){
const v=vehicles.find(v=>v.id===S.fleetBooking.vehicleId);
const step=S.fleetBookStep||1;
const svcSearch=(S.fleetSvcSearch||'').toLowerCase();
const filteredSvcs=SERVICES.filter(s=>!s.diag&&(svcSearch===''||s.label.toLowerCase().includes(svcSearch)||s.cat.toLowerCase().includes(svcSearch)));
const cats=[...new Set(filteredSvcs.map(s=>s.cat))];
if(S.fleetBookDone){
body=`<div style="text-align:center;padding:2rem;"><div style="font-size:3rem;">✓</div><div class="ph2" style="margin:1rem 0 .5rem;">Service Booked!</div><p class="pmuted">${sub?'Labor covered by your '+planName+'. Parts quoted separately with '+sub.parts_discount_pct+'% fleet discount.':'Booking submitted. Standard labor rates apply.'}</p><button class="pbtn gold" style="margin-top:1rem;" id="p-fleet-book-another">Book Another</button></div>`;
}else if(step===1){
body=`<div class="ph3" style="margin-bottom:.8rem;">Select Vehicle</div>
${vehicles.map(v=>`<div class="psvc ${S.fleetBooking.vehicleId===v.id?'sel':''}" data-fleet-pick-vehicle="${esc(v.id)}" style="cursor:pointer;flex-direction:column;align-items:flex-start;gap:.15rem;margin-bottom:.4rem;">
<strong style="color:${S.fleetBooking.vehicleId===v.id?C.gold:C.cream};font-size:.85rem;">${esc(v.nickname||`${v.year} ${v.make} ${v.model}`)}</strong>
<span class="pmuted" style="font-size:.75rem;">${esc(v.year)} ${esc(v.make)} ${esc(v.model)}${v.vin?` · VIN: ${esc(v.vin)}`:''}</span>
</div>`).join('')}
<button class="pbtn gold full" style="margin-top:1rem;" id="p-fleet-step1-next" ${!S.fleetBooking.vehicleId?'disabled':''}>Continue →</button>`;
}else if(step===2){
body=`<div class="ph3" style="margin-bottom:.4rem;">Select Services</div>
<p class="pmuted" style="font-size:.82rem;margin-bottom:.8rem;">Select one or more services for <strong style="color:${C.cream};">${esc(v?v.nickname||`${v.year} ${v.make} ${v.model}`:'vehicle')}</strong>. You can pick multiple for one visit.</p>
<input class="pinp" id="fleet-svc-search" placeholder="Search services (e.g. brakes, oil, timing...)" value="${esc(S.fleetSvcSearch||'')}" style="margin-bottom:.8rem;">
${S.fleetBooking.services.length>0?`<div style="background:rgba(201,168,76,.08);border:1px solid rgba(201,168,76,.2);border-radius:6px;padding:.6rem .8rem;margin-bottom:.8rem;font-size:.8rem;color:${C.gold};">Selected: ${S.fleetBooking.services.map(sid=>{const s=SERVICES.find(sv=>sv.id===sid);return s?s.label:'';}).filter(Boolean).join(', ')}</div>`:''}
${cats.length===0?`<div class="pcard" style="text-align:center;padding:1.5rem;color:${C.muted};">No services match "${esc(svcSearch)}" — try a different keyword</div>`
:cats.map(cat=>`<div style="margin-bottom:1rem;">
<div style="font-size:.72rem;font-weight:600;color:${C.gold};text-transform:uppercase;letter-spacing:.08em;margin-bottom:.3rem;">${esc(cat)}</div>
${filteredSvcs.filter(s=>s.cat===cat).map(s=>{const sel=S.fleetBooking.services.includes(s.id);return`<div class="psvc ${sel?'sel':''}" data-fleet-toggle-svc="${esc(s.id)}" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center;margin-bottom:.3rem;padding:.5rem .8rem;">
<span style="font-size:.82rem;color:${sel?C.gold:C.cream};">${esc(s.label)}</span>
<span style="font-size:.76rem;color:${C.muted};flex-shrink:0;">${s.hours}hr${sub?' (covered)':` · $${Math.round(s.hours*100)}`}</span>
</div>`;}).join('')}
</div>`).join('')}
<div style="display:flex;gap:.7rem;margin-top:.8rem;"><button class="pbtn full" style="background:rgba(245,240,232,.08);color:${C.cream};" id="p-fleet-step2-back">← Back</button><button class="pbtn gold full" id="p-fleet-step2-next" ${S.fleetBooking.services.length===0?'disabled':''}>${S.fleetBooking.services.length} service${S.fleetBooking.services.length===1?'':'s'} — Continue →</button></div>`;
}else if(step===3){
const totalHrs=S.fleetBooking.services.reduce((sum,sid)=>{const s=SERVICES.find(sv=>sv.id===sid);return sum+(s?s.hours:0);},0);
body=`<div class="pcard" style="margin-bottom:1rem;">
<div class="ph3" style="margin-bottom:.5rem;">Service Summary</div>
${S.fleetBooking.services.map(sid=>{const s=SERVICES.find(sv=>sv.id===sid);return s?`<div style="display:flex;justify-content:space-between;font-size:.83rem;padding:.3rem 0;border-bottom:0.5px solid rgba(201,168,76,.1);"><span>${esc(s.label)}</span><span style="color:${C.gold};">${s.hours}hr</span></div>`:''}).join('')}
<div style="display:flex;justify-content:space-between;font-size:.85rem;font-weight:600;padding:.4rem 0 0;"><span>Total</span><span style="color:${C.gold};">${totalHrs.toFixed(1)}hrs ${sub?'(labor covered)':'@ $100/hr = '+money(totalHrs*100)}</span></div>
</div>
<div style="margin-bottom:.7rem;"><label class="plbl">Date *</label><input class="pinp" id="fb-date" type="date" min="${todayStr()}" max="${maxDateStr()}" value="${esc(S.fleetBooking.date)}"></div>
<div style="margin-bottom:.7rem;"><label class="plbl">Time *</label><select class="pinp" id="fb-time">${['8:00 AM','9:00 AM','10:00 AM','11:00 AM','12:00 PM','1:00 PM','2:00 PM','3:00 PM','4:00 PM','5:00 PM'].map(ti=>`<option ${S.fleetBooking.time===ti?'selected':''}>${ti}</option>`).join('')}</select></div>
<div style="margin-bottom:.7rem;"><label class="plbl">Location *</label><input class="pinp" id="fb-location" placeholder="123 Main St, Austin TX" value="${esc(S.fleetBooking.location)}"></div>
<div style="margin-bottom:1rem;"><label class="plbl">Notes</label><textarea class="pinp ptarea" id="fb-notes">${esc(S.fleetBooking.notes)}</textarea></div>
${sub?`<div class="pcard gold" style="margin-bottom:1rem;font-size:.82rem;"><strong style="color:${C.gold};">Labor covered by ${esc(planName)}</strong><br>Parts (if needed) billed separately with ${sub.parts_discount_pct}% fleet discount.</div>`:`<div class="pcard blue" style="margin-bottom:1rem;font-size:.82rem;color:#93c5fd;">No FleetCare plan — standard rates apply. Parts billed at retail.</div>`}
${S.fleetBookErr?`<div class="perr" style="margin-bottom:.8rem;">${esc(S.fleetBookErr)}</div>`:''}
<div style="display:flex;gap:.7rem;"><button class="pbtn full" style="background:rgba(245,240,232,.08);color:${C.cream};" id="p-fleet-step3-back">← Back</button><button class="pbtn gold full" id="p-fleet-step3-submit" ${S.loading?'disabled':''}>${S.loading?'Submitting…':'Confirm Booking'}</button></div>`;
}
}
if(t==='schedule'){
body=appts.length===0?`<div class="pcard" style="text-align:center;padding:2.5rem;color:rgba(245,240,232,.25);">No service history yet.</div>`
:appts.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).map(a=>{
const veh=vehicles.find(v=>v.id===a.fleetVehicleId);
const svcList=Array.isArray(a.services)?a.services.map(sid=>{const s=SERVICES.find(sv=>sv.id===sid);return s?s.label:sid;}).join(', '):(a.serviceName||a.service||'—');
return`<div class="pcard" style="margin-bottom:.6rem;"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap;">
<div><strong style="font-size:.88rem;">${esc(svcList)}</strong>
<div class="pmuted" style="font-size:.78rem;">${veh?esc(veh.nickname||`${veh.year} ${veh.make} ${veh.model}`):esc(`${a.year} ${a.make} ${a.model}`)} · ${fmtDate(a.date)} ${esc(a.time)}</div>
${a.laborCoveredBySubscription?`<span style="font-size:.74rem;color:${C.gold};">Labor covered by FleetCare</span>`:''}
${a.partsDiscountPct>0?`<span style="font-size:.74rem;color:#4ade80;"> · ${a.partsDiscountPct}% parts discount</span>`:''}
</div><span class="pbadge ${a.status}">${esc(a.status.replace('_',' ').toUpperCase())}</span>
</div></div>`;}).join('');
}
if(t==='plan'){
const plans=S.fleetPlans||[];
body=`${sub?`<div class="pcard gold" style="margin-bottom:1.5rem;">
<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:1rem;">
<div><strong style="color:${C.gold};display:block;">${esc(sub.plan_name)}</strong>
<div class="pmuted" style="font-size:.8rem;">${money(sub.monthly_price)}/mo · ${sub.vehicle_limit} vehicles · ${sub.labor_hours_cap_per_vehicle}hr/vehicle/mo · ${sub.parts_discount_pct}% parts off</div>
<div style="margin-top:.4rem;font-size:.79rem;">Hours this period: <span style="color:${C.cream};">${hoursUsed.toFixed(1)} / ${hoursCap.toFixed(1)}hrs</span></div>
</div><button class="pbtn red sm" id="p-cancel-fleetcare">Cancel Plan</button>
</div></div>`:`<p class="pmuted" style="margin-bottom:1.2rem;font-size:.85rem;">Subscribe to cover labor costs monthly with fleet-wide parts discounts.</p>`}
<div style="display:grid;gap:.7rem;">
${plans.map(p=>{const isCurrent=sub&&sub.plan_id===p.id;const isEnt=p.id==='enterprise';
return`<div class="pcard ${isCurrent?'gold':''}">
<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.8rem;">
<div><strong style="color:${isCurrent?C.gold:C.cream};">${esc(p.name)}</strong>
<div class="pmuted" style="font-size:.78rem;">${p.vehicleMin}${p.vehicleMax?'–'+p.vehicleMax:'+'} vehicles · ${p.laborHoursCap}hr/vehicle/mo covered · ${p.partsDiscountPct}% parts discount</div></div>
<div style="text-align:right;flex-shrink:0;">
<div style="font-size:1.05rem;font-weight:700;color:${isCurrent?C.gold:C.cream};">${isEnt?'Custom':money(p.monthlyPrice)}/mo</div>
${!isCurrent&&!sub?`<button class="pbtn gold sm" style="margin-top:.3rem;" data-subscribe-plan="${esc(p.id)}">${isEnt?'Request Quote':'Subscribe →'}</button>`:isCurrent?`<span style="font-size:.77rem;color:${C.gold};">✓ Active</span>`:''}
</div></div></div>`;}).join('')}
</div>
${S.fleetSubErr?`<div class="perr" style="margin-top:1rem;">${esc(S.fleetSubErr)}</div>`:''}
${S.fleetSubDone?`<div class="pcard" style="background:rgba(74,222,128,.08);border:1px solid rgba(74,222,128,.25);margin-top:1rem;"><p style="color:#4ade80;margin:0;">✓ FleetCare activated! Your plan is now live.</p></div>`:''}
<div id="fleet-stripe-card-container" style="display:none;margin-top:1rem;">
<div class="pcard"><label class="plbl" style="margin-bottom:.5rem;display:block;">Payment Details</label>
<div id="fleet-card-element" style="background:rgba(10,10,15,.6);border:1px solid rgba(201,168,76,.25);border-radius:8px;padding:.9rem;"></div>
<button class="pbtn gold full" style="margin-top:.8rem;" id="p-confirm-fleet-sub">Confirm Subscription</button>
<button class="pbtn full" style="background:rgba(245,240,232,.08);color:${C.cream};margin-top:.5rem;" id="p-cancel-fleet-sub-form">Cancel</button>
</div></div>`;
}
return`<div style="margin-bottom:1.5rem;"><span class="peye">Fleet Portal</span><div class="ph1">${esc(fleet.companyName)}</div>
${sub?`<div style="font-size:.81rem;color:${C.gold};margin-top:.3rem;">${esc(planName)} · ${hoursUsed.toFixed(1)}/${hoursCap.toFixed(1)}hrs used this period</div>`:''}
</div>
<div class="pstgrid">${[['Vehicles',vehicles.length],['Records',appts.length],['Active',appts.filter(a=>['approved','pending'].includes(a.status)).length]].map(([l,v])=>`<div class="pcard pst"><div class="pst-num">${v}</div><div class="pmuted">${l}</div></div>`).join('')}</div>
<div style="display:flex;gap:.3rem;margin-bottom:1.8rem;border-bottom:1px solid rgba(201,168,76,.12);flex-wrap:wrap;">
${[['vehicles','Vehicles'],['book','Schedule'],['schedule','History'],['plan','FleetCare']].map(([tb,lbl])=>`<button class="ptab ${S.fleetTab===tb?'blue active':''}" data-fleet-tab="${tb}" style="border-radius:6px 6px 0 0;padding-bottom:.7rem;">${lbl}</button>`).join('')}
</div>${body}`;
}

function renderFleetBookingModal(){
const v = S.fleetVehicles.find(x=>x.id===S.fleetBookingVehicle);
if (!v) return '';
const f = S.booking;
return `
<div id="p-fleetbook-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:9998;display:flex;align-items:center;justify-content:center;padding:1.5rem;overflow-y:auto;">
<div class="pcard blue" style="max-width:480px;width:100%;margin:2rem 0;">
<div class="ph3" style="margin-bottom:1rem;">📅 Schedule Service — ${esc(v.nickname||`${v.year} ${v.make} ${v.model}`)}</div>
<div style="margin-bottom:1rem;"><label class="plbl">Service Type</label><select class="pinp" id="fb-service"><option value="">Select service</option>${SERVICES.map(s=>`<option value="${s.id}">${esc(s.label)}</option>`).join('')}</select></div>
<div style="margin-bottom:1rem;"><label class="plbl">Date</label><input class="pinp" type="date" id="fb-date" min="${todayStr()}" max="${maxDateStr()}"></div>
<div style="margin-bottom:1rem;"><label class="plbl">Time</label><select class="pinp" id="fb-time"><option value="">Select time</option>${TIME_SLOTS.map(t=>`<option value="${t}">${t}</option>`).join('')}</select></div>
<div style="margin-bottom:1rem;"><label class="plbl">Location</label><input class="pinp" id="fb-location" placeholder="Where is this vehicle?"></div>
<div style="margin-bottom:1.2rem;"><label class="plbl">Notes</label><textarea class="pinp ptarea" id="fb-notes" placeholder="Describe the issue or routine service needed..."></textarea></div>
<div style="display:flex;gap:.6rem;">
<button class="pbtn ghost" id="p-fleetbook-cancel">Cancel</button>
<button class="pbtn blue" id="p-fleetbook-submit">Submit Request</button>
</div>
</div>
</div>`;
}
function renderTowPortal(){
if (S.loading) return `<div style="text-align:center;padding:3rem;"><div class="pbigspinner"></div><p class="pmuted" style="margin-top:1rem;">Loading tow requests…</p></div>`;
const tow = S.tow;
const all = S.towAllReqs;
const available = all.filter(r=>r.status==='pending');
const myJobs = all.filter(r=>r.towCompanyId===tow.id);
const t = S.towTab;
let body='';
if (t==='available') {
body = available.length===0
? `<div class="pcard" style="text-align:center;padding:2.5rem;color:rgba(245,240,232,.25);">No tow requests right now.</div>`
: available.map(r=>`<div class="pcard orange">
<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap;margin-bottom:.7rem;">
<div><strong>${esc(r.customerName)}</strong><div class="pmuted">${esc(r.phone)}</div></div>
<span class="pbadge pending">NEW REQUEST</span>
</div>
<div style="font-size:.85rem;margin-bottom:.6rem;"><strong>Pickup:</strong> ${esc(r.pickupLocation)}</div>
${r.dropoffLocation?`<div style="font-size:.85rem;margin-bottom:.6rem;"><strong>Drop-off:</strong> ${esc(r.dropoffLocation)}</div>`:''}
${r.vehicle?`<div class="pmuted" style="font-size:.82rem;margin-bottom:.6rem;">Vehicle: ${esc(r.vehicle)}</div>`:''}
${r.notes?`<div style="padding:.5rem .8rem;background:rgba(255,255,255,.03);border-radius:6px;font-size:.8rem;font-style:italic;margin-bottom:.8rem;">"${esc(r.notes)}"</div>`:''}
<button class="pbtn orange" data-tow-accept="${esc(r.id)}">✓ Accept Tow Job</button>
</div>`).join('');
}
if (t==='myjobs') {
body = myJobs.length===0
? `<div class="pcard" style="text-align:center;padding:2.5rem;color:rgba(245,240,232,.25);">No jobs claimed yet.</div>`
: myJobs.sort((a,b)=>new Date(b.claimedAt||b.createdAt)-new Date(a.claimedAt||a.createdAt)).map(r=>`<div class="pcard">
<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap;margin-bottom:.7rem;">
<div><strong>${esc(r.customerName)}</strong><div class="pmuted">${esc(r.phone)}</div></div>
<span class="pbadge ${r.status}">${r.status.toUpperCase()}</span>
</div>
<div style="font-size:.85rem;margin-bottom:.6rem;"><strong>Pickup:</strong> ${esc(r.pickupLocation)}</div>
<div style="display:flex;gap:.5rem;flex-wrap:wrap;">
<a href="tel:${esc(r.phone)}" class="pbtn ghost sm" style="text-decoration:none;">📞 Call</a>
${r.status==='claimed'?`<button class="pbtn grn sm" data-tow-complete="${esc(r.id)}">✓ Mark Complete</button>`:''}
</div>
</div>`).join('');
}
return `
<div style="margin-bottom:1.6rem;">
<span class="peye">Towing Partner Portal</span>
<div class="ph1">${esc(tow.companyName)}</div>
</div>
<div class="pstgrid">
${[['Available Requests',available.length],['My Active Jobs',myJobs.filter(r=>r.status==='claimed').length],['Completed',myJobs.filter(r=>r.status==='completed').length]].map(([l,v])=>`<div class="pcard pst"><div class="pst-num">${v}</div><div class="pmuted">${l}</div></div>`).join('')}
</div>
<div style="display:flex;gap:.3rem;margin-bottom:1.8rem;border-bottom:1px solid rgba(201,168,76,.12);">
${[['available','Available Requests'],['myjobs','My Jobs']].map(([tb,lbl])=>`<button class="ptab ${S.towTab===tb?'orange active':''}" data-tow-tab="${tb}" style="border-radius:6px 6px 0 0;padding-bottom:.7rem;">${lbl}</button>`).join('')}
</div>
${body}`;
}
function bind(){
document.querySelectorAll('[data-nav]').forEach(el=>el.addEventListener('click',()=>nav(el.dataset.nav)));
document.querySelectorAll('[data-nav-step]').forEach(el=>el.addEventListener('click',()=>{S.bookStep=parseInt(el.dataset.navStep);render();}));
document.getElementById('p-logout')?.addEventListener('click',()=>{
Session.set(null); Session.setAdmin(false); Session.setTech(null); Session.setFleet(null); Session.setTow(null);
S.user=null;S.isAdmin=false;S.tech=null;S.fleet=null;S.tow=null;S.view='home';render();toast('Signed out.');
});
document.querySelectorAll('[data-tech-login-shortcut]').forEach(el=>el.addEventListener('click',()=>{
S.loginForm.mode='tech'; S.loginErr=''; S.view='login'; render();
setTimeout(()=>document.getElementById('ueaportal')?.scrollIntoView({behavior:'smooth',block:'start'}),50);
}));
document.querySelectorAll('[data-account-type]').forEach(el=>el.addEventListener('click',()=>{
const type = el.dataset.accountType;
if (type==='cust') nav('register');
if (type==='fleet') nav('fleetregister');
if (type==='tech') nav('techapply');
}));
if (S.view==='book'&&!S.bookDone&&S.bookStep===1){
document.getElementById('b-year')?.addEventListener('change', async e=>{
S.booking.year=e.target.value; S.booking.make='';S.booking.model='';
S.veh.makes=[];S.veh.models=[];S.veh.loadingMakes=true; render();
if (S.booking.year){ S.veh.makes=await VehicleDB.getMakes(S.booking.year); S.veh.loadingMakes=false; render(); }
});
document.getElementById('b-make')?.addEventListener('change', async e=>{
S.booking.make=e.target.value; S.booking.model=''; S.veh.models=[];S.veh.loadingModels=true; render();
if (S.booking.make&&S.booking.year){ S.veh.models=await VehicleDB.getModels(S.booking.year,S.booking.make); S.veh.loadingModels=false; render(); }
});
document.getElementById('b-model')?.addEventListener('change',e=>{ S.booking.model=e.target.value; render(); });
document.querySelectorAll('[data-svc]').forEach(el=>el.addEventListener('click',()=>{ S.booking.service=el.dataset.svc;S.booking.repairDesc='';S.booking.partsChoice='';render(); }));
document.getElementById('b-repdesc')?.addEventListener('input',e=>{
S.booking.repairDesc=e.target.value;
const btn=document.getElementById('p-s1-next');
if(btn){const svc=SERVICES.find(s=>s.id===S.booking.service);const isDiag=svc?.diag;btn.disabled=!(S.booking.year&&S.booking.make&&S.booking.model&&S.booking.service&&(isDiag||e.target.value.trim().length>5));}
});
document.getElementById('p-rush-toggle')?.addEventListener('click',e=>{ if(e.target.type!=='checkbox'){S.booking.rush=!S.booking.rush;render();} });
document.getElementById('b-rush')?.addEventListener('change',e=>{S.booking.rush=e.target.checked;});
document.getElementById('p-emergency-toggle')?.addEventListener('click',e=>{ if(e.target.type!=='checkbox'){S.booking.emergency=!S.booking.emergency;render();} });
document.getElementById('b-emergency')?.addEventListener('change',e=>{S.booking.emergency=e.target.checked;});
document.getElementById('p-s1-next')?.addEventListener('click',()=>{S.bookStep=2;render();});
}
if (S.view==='book'&&!S.bookDone&&S.bookStep===2){
document.querySelectorAll('[data-parts]').forEach(el=>el.addEventListener('click',()=>{ S.booking.partsChoice=el.dataset.parts; render(); }));
document.getElementById('p-s2-next')?.addEventListener('click',()=>{S.bookStep=3;render();});
}
if (S.view==='book'&&!S.bookDone&&S.bookStep===3){
document.getElementById('b-date')?.addEventListener('change',async e=>{
S.booking.date=e.target.value; S.booking.time=''; render();
await loadTimeSlots();
});
if (S.booking.date) loadTimeSlots();
document.getElementById('p-s3-next')?.addEventListener('click',()=>{S.bookStep=4;render();});
}
if (S.view==='book'&&!S.bookDone&&S.bookStep===4){
['name','email','phone','location','notes'].forEach(k=>{
document.getElementById(`b-${k}`)?.addEventListener('input',e=>{
S.booking[k]=e.target.value;
const btn=document.getElementById('p-s4-next');
if(btn)btn.disabled=!(S.booking.name&&S.booking.phone&&S.booking.location);
});
});
document.getElementById('p-s4-next')?.addEventListener('click',()=>{
['name','email','phone','location','notes'].forEach(k=>{const el=document.getElementById(`b-${k}`);if(el)S.booking[k]=el.value;});
S.bookStep=5;render();
});
}
if(S.view==='book'&&!S.bookDone&&S.bookStep===5){
if(!S._cardMounted){S._cardMounted=true;Payments.mountCardElement('book-card-element');}
document.getElementById('p-submit')?.addEventListener('click',async()=>{
const btn=document.getElementById('p-submit');
btn.disabled=true;btn.textContent='…';
const id=genId();
const svc=SERVICES.find(s=>s.id===S.booking.service);
const isMember = !!S.user?.membership;
const est = calcEstimate(S.pricing, S.booking.service, S.booking.partsChoice, isMember, S.booking.rush);
S.paymentLoading=true;S.paymentErr='';render();
const payResult=await Payments.payForAppointment(id,est.total,S.booking.email||S.user?.email||'',S.booking.name);
S.paymentLoading=false;
if(!payResult.success){S.paymentErr=payResult.error||'Payment failed. Please check your card and try again.';render();Payments.unmountCardElement();await Payments.mountCardElement('book-card-element');return;}
const appt={id,...S.booking,serviceName:svc?.label||S.booking.service,servicePoints:PTS_MAP[S.booking.service]||30,status:'pending',createdAt:new Date().toISOString(),userId:S.user?.id||null,pointsAwarded:false,adminNote:'',estimatedPrice:est.total,laborHours:est.laborHours||0,partsCost:est.parts||0,paymentStatus:'paid',paidAt:new Date().toISOString()};
await Data.createAppointment(appt);
if(S.user){const newBookings=[...(S.user.bookings||[]),id];S.user.bookings=newBookings;await Data.updateUser(S.user.id,{bookings:newBookings});}
Payments.unmountCardElement();
await Promise.all([Emailer.onBooking(appt),SMS.sendToAdmin(appt)]);
S.bookDone=true;render();
});
}
if (S.view==='book'&&S.bookDone){
document.getElementById('p-book-another')?.addEventListener('click',()=>{S.bookDone=false;nav('book');});
}
if (S.view==='tow'&&!S.towDone){
['name','phone','email','vehicle','pickup','dropoff','notes'].forEach(k=>{
const map={name:'customerName',phone:'phone',email:'email',vehicle:'vehicle',pickup:'pickupLocation',dropoff:'dropoffLocation',notes:'notes'};
document.getElementById(`tw-${k}`)?.addEventListener('input',e=>{
S.towForm[map[k]]=e.target.value;
const btn=document.getElementById('p-tow-submit');
if(btn)btn.disabled=!(S.towForm.customerName&&S.towForm.phone&&S.towForm.pickupLocation);
});
});
document.getElementById('p-tow-submit')?.addEventListener('click', async()=>{
const btn=document.getElementById('p-tow-submit');
btn.disabled=true;btn.textContent='Sending…';
const id=genId();
const req={id,...S.towForm,status:'pending',createdAt:new Date().toISOString()};
await Data.createTowRequest(req);
await SMS.sendTowAlert(req);
const towCos = await Data.getTowCompanies();
await Emailer.onNewTowRequest(req, towCos);
S.towDone=true; render();
});
}
if (S.view==='login'){
document.querySelectorAll('[data-login-mode]').forEach(el=>el.addEventListener('click',()=>{ S.loginForm.mode=el.dataset.loginMode; S.loginErr=''; render(); }));
document.getElementById('l-email')?.addEventListener('input',e=>S.loginForm.email=e.target.value);
document.getElementById('l-pass')?.addEventListener('input',e=>S.loginForm.pass=e.target.value);
document.getElementById('l-pin')?.addEventListener('input',e=>S.loginForm.pin=e.target.value);
document.getElementById('t-name')?.addEventListener('input',e=>S.loginForm.techId=e.target.value);
document.getElementById('t-pin')?.addEventListener('input',e=>S.loginForm.techPin=e.target.value);
document.getElementById('fl-email')?.addEventListener('input',e=>S.loginForm.fleetEmail=e.target.value);
document.getElementById('fl-pass')?.addEventListener('input',e=>S.loginForm.fleetPass=e.target.value);
document.getElementById('tw-login-phone')?.addEventListener('input',e=>S.loginForm.towPhone=e.target.value);
document.getElementById('tw-login-pin')?.addEventListener('input',e=>S.loginForm.towPin=e.target.value);
document.getElementById('p-do-login')?.addEventListener('click', doLogin);
document.getElementById('p-do-tech-login')?.addEventListener('click', doTechLogin);
document.getElementById('p-do-fleet-login')?.addEventListener('click', doFleetLogin);
document.getElementById('p-do-tow-login')?.addEventListener('click', doTowLogin);
document.getElementById('p-do-admin')?.addEventListener('click',()=>{
if(S.loginForm.pin===CONFIG.ADMIN_PIN){ Session.setAdmin(true); S.isAdmin=true; nav('admin'); toast('Welcome, Robert!'); }
else { S.loginErr='Incorrect PIN.'; render(); }
});
}
if(S.view==='techapply'&&!S.techRegDone){const step=S.techRegStep||1;if(step===1){['tr-name','tr-email','tr-phone','tr-pass','tr-confirm'].forEach(id=>{document.getElementById(id)?.addEventListener('input',e=>{const k={'tr-name':'name','tr-email':'email','tr-phone':'phone','tr-pass':'password','tr-confirm':'confirm'}[id];if(k)S.techRegForm[k]=e.target.value;});});document.getElementById('tr-step1-next')?.addEventListener('click',()=>{const f=S.techRegForm;S.techRegErr='';if(!f.name||!f.email||!f.phone){S.techRegErr='Name, email & phone required.';render();return;}if(!f.password||f.password.length<6){S.techRegErr='Password min 6 chars.';render();return;}if(f.password!==f.confirm){S.techRegErr="Passwords don't match.";render();return;}S.techRegStep=2;render();});}if(step===2){['tr-vyear','tr-vmake','tr-vmodel','tr-pin'].forEach(id=>{document.getElementById(id)?.addEventListener('input',e=>{const k={'tr-vyear':'vehicleYear','tr-vmake':'vehicleMake','tr-vmodel':'vehicleModel','tr-pin':'pin'}[id];if(k)S.techRegForm[k]=e.target.value;});});document.getElementById('tr-step2-back')?.addEventListener('click',()=>{S.techRegStep=1;S.techRegErr='';render();});document.getElementById('tr-step2-next')?.addEventListener('click',()=>{const f=S.techRegForm;S.techRegErr='';if(!f.vehicleYear||!f.vehicleMake||!f.vehicleModel){S.techRegErr='Vehicle details required.';render();return;}if(!f.pin||f.pin.length<4){S.techRegErr='PIN min 4 chars.';render();return;}S.techRegStep=3;render();});}if(step===3){document.getElementById('tr-step3-back')?.addEventListener('click',()=>{S.techRegStep=2;S.techRegErr='';render();});document.getElementById('tr-step3-submit')?.addEventListener('click',async()=>{S.techRegErr='';const sf=document.getElementById('tr-selfie');const inf=document.getElementById('tr-insurance');if(!sf?.files?.length){S.techRegErr='Selfie with ID required.';render();return;}if(!inf?.files?.length){S.techRegErr='Insurance doc required.';render();return;}const ex=await Data.getTechnicians();if(Object.values(ex).some(t=>t.name.toLowerCase()===S.techRegForm.name.toLowerCase())){S.techRegErr='Name taken. Contact Robert.';render();return;}S.loading=true;render();const tid=genId();async function uld(fi,dt){if(!fi?.files?.length)return null;const se=document.getElementById(fi.id+'-status');if(se){se.style.display='block';se.textContent='…';}const fd=new FormData();fd.append('file',fi.files[0]);fd.append('techId',tid);fd.append('docType',dt);try{const r=await fetch(`${CONFIG.BACKEND_URL}/upload-tech-doc`,{method:'POST',body:fd});const d=await r.json();if(!r.ok||!d.url)throw new Error(d.error||'Failed');if(se){se.textContent='✓';se.style.color='#4ade80';}return d.url;}catch(e){if(se){se.textContent='✗ '+e.message;se.style.color='#f87171';}return null;}}const idUrl=await uld(sf,'id_selfie');const insUrl=await uld(inf,'insurance');const eqUrl=await uld(document.getElementById('tr-equipment'),'equipment');const acUrl=await uld(document.getElementById('tr-cert'),'ase_cert');if(!idUrl||!insUrl){S.techRegErr='Upload failed. Retry.';S.loading=false;render();return;}const f=S.techRegForm;await Data.createTechnician({id:tid,name:f.name,pin:f.pin,email:f.email,phone:f.phone,active:false,jobEligible:false,verificationStatus:'pending',idDocUrl:idUrl,insuranceDocUrl:insUrl,equipmentPhotoUrl:eqUrl||null,aseCertUrl:acUrl||null,vehicleYear:f.vehicleYear,vehicleMake:f.vehicleMake,vehicleModel:f.vehicleModel,totalEarned:0,jobsCompleted:0,createdAt:new Date().toISOString()});await Emailer.onTechVerification({name:f.name,email:f.email},'pending');S.loading=false;S.techRegDone=true;render();});}}
if (S.view==='register'){
['r-name','r-phone','r-email','r-vehicle','r-pass','r-confirm'].forEach(id=>document.getElementById(id)?.addEventListener('input',e=>{
const k={'r-name':'name','r-phone':'phone','r-email':'email','r-vehicle':'vehicle','r-pass':'password','r-confirm':'confirm'}[id];
if(k)S.regForm[k]=e.target.value;
}));
document.getElementById('p-do-reg')?.addEventListener('click', doRegister);
}
if (S.view==='fleetregister'){
['flr-company','flr-contact','flr-phone','flr-email','flr-pass','flr-confirm'].forEach(id=>document.getElementById(id)?.addEventListener('input',e=>{
const k={'flr-company':'companyName','flr-contact':'contactName','flr-phone':'phone','flr-email':'email','flr-pass':'password','flr-confirm':'confirm'}[id];
if(k)S.fleetRegForm[k]=e.target.value;
}));
document.getElementById('p-do-fleet-reg')?.addEventListener('click', doFleetRegister);
}
document.querySelectorAll('[data-dash-tab]').forEach(el=>el.addEventListener('click',()=>{S.dashTab=el.dataset.dashTab;render();}));
document.querySelectorAll('[data-redeem]').forEach(el=>el.addEventListener('click',()=>toast(`To redeem "${el.dataset.redeem}", mention it at your next appointment.`,'info')));
document.querySelectorAll('[data-accept-alt]').forEach(el=>el.addEventListener('click',async()=>{
const id=el.dataset.acceptAlt;
const a=S.dashAppts.find(x=>x.id===id);
if(!a)return;
await Data.updateAppointment(id,{date:a.altDate,time:a.altTime,status:'approved',altDate:null,altTime:null});
await loadDashboard();
toast('Alternative time accepted! Your appointment is confirmed.');
}));
document.querySelectorAll('[data-reject-alt]').forEach(el=>el.addEventListener('click',async()=>{
const id=el.dataset.rejectAlt;
await Data.updateAppointment(id,{status:'pending',altDate:null,altTime:null,adminNote:''});
await loadDashboard();
toast('Alternative time declined. Robert will be in touch.','info');
}));
document.getElementById('p-join-membership')?.addEventListener('click', async()=>{
if(!S.user)return;
S.membershipModal=true; S.paymentErr=''; render();
await Payments.mountCardElement('membership-card-element');
});
document.getElementById('p-membership-cancel')?.addEventListener('click', ()=>{
Payments.unmountCardElement();
S.membershipModal=null; render();
});
document.getElementById('p-membership-submit')?.addEventListener('click', async()=>{
if(!S.user)return;
S.paymentLoading=true; S.paymentErr=''; render();
const result = await Payments.startMembership(S.user.id, S.user.email, S.user.name);
S.paymentLoading=false;
if (!result.success) { S.paymentErr=result.error; render(); return; }
S.user.membership=true; S.user.membershipSince=new Date().toISOString();
Payments.unmountCardElement();
S.membershipModal=null; render();
toast(`Welcome to Upper Echelon Membership! Free diagnostics & ${CONFIG.MEMBERSHIP_DISCOUNT_PCT}% off repairs unlocked.`);
});
document.getElementById('p-cancel-membership')?.addEventListener('click', async()=>{
if(!S.user)return;
const ok = await Payments.cancelMembership(S.user.id);
if (!ok) { toast('Could not cancel membership — please try again or contact support.', 'error'); return; }
S.user.membership=false;
render();
toast('Membership cancelled.','info');
});
document.querySelectorAll('[data-pay-job]').forEach(el=>el.addEventListener('click', async()=>{
const appt = S.dashAppts.find(a=>a.id===el.dataset.payJob);
if(!appt)return;
S.payModal=appt; S.paymentErr=''; render();
await Payments.mountCardElement('pay-card-element');
}));
document.getElementById('p-pay-cancel')?.addEventListener('click', ()=>{
Payments.unmountCardElement();
S.payModal=null; render();
});
document.getElementById('p-pay-submit')?.addEventListener('click', async()=>{
const appt = S.payModal;
if(!appt)return;
S.paymentLoading=true; S.paymentErr=''; render();
const result = await Payments.payForAppointment(appt.id, appt.estimatedPrice, appt.email||S.user?.email, appt.name);
S.paymentLoading=false;
if (!result.success) { S.paymentErr=result.error; render(); return; }
Payments.unmountCardElement();
S.payModal=null;
await loadDashboard();
toast('Payment successful! Thank you for choosing Upper Echelon Automotive.');
});
document.querySelectorAll('[data-rate-job]').forEach(el=>el.addEventListener('click',()=>{
const appt = S.dashAppts.find(a=>a.id===el.dataset.rateJob);
if(!appt)return;
S.ratingModal=appt; S.ratingValue=0; S.ratingComment=''; render();
}));
document.querySelectorAll('.p-star-btn').forEach(el=>el.addEventListener('click',()=>{
S.ratingValue=parseInt(el.dataset.star); render();
}));
document.getElementById('p-rating-comment')?.addEventListener('input',e=>{S.ratingComment=e.target.value;});
document.getElementById('p-rating-cancel')?.addEventListener('click',()=>{ S.ratingModal=null; render(); });
document.getElementById('p-rating-submit')?.addEventListener('click', async()=>{
const appt = S.ratingModal;
if(!appt||!S.ratingValue)return;
await Data.updateAppointment(appt.id,{rating:S.ratingValue, ratingComment:S.ratingComment||''});
if (appt.technicianId) {
const techs = await Data.getTechnicians();
const tech = techs[appt.technicianId];
if (tech) {
const newCount = (tech.ratingCount||0)+1;
const newAvg = (((tech.avgRating||5)*(tech.ratingCount||0)) + S.ratingValue) / newCount;
await Data.updateTechnician(tech.id, {avgRating:Math.round(newAvg*10)/10, ratingCount:newCount});
if (newCount >= CONFIG.MIN_RATINGS_FOR_GRADING && newAvg < CONFIG.MIN_TECH_RATING) {
await Data.updateTechnician(tech.id, {active:false});
}
}
}
S.ratingModal=null;
await loadDashboard();
toast('Thank you for rating your service!');
});
document.getElementById('p-refresh')?.addEventListener('click', loadAdmin);
document.querySelectorAll('[data-atab]').forEach(el=>el.addEventListener('click',()=>{S.adminTab=el.dataset.atab;render();}));
document.getElementById('p-asearch')?.addEventListener('input',e=>{S.adminSearch=e.target.value;render();});
document.querySelectorAll('[data-anote]').forEach(el=>el.addEventListener('input',e=>{S.adminNotes[el.dataset.anote]=e.target.value;}));
document.querySelectorAll('[data-aalt-date]').forEach(el=>el.addEventListener('change',e=>{S.adminAltDate[el.dataset.aaltDate]=e.target.value;}));
document.querySelectorAll('[data-aalt-time]').forEach(el=>el.addEventListener('change',e=>{S.adminAltTime[el.dataset.aaltTime]=e.target.value;}));
document.querySelectorAll('[data-approve]').forEach(el=>el.addEventListener('click',async()=>{
const id=el.dataset.approve;
const patch={status:'approved',adminNote:S.adminNotes[id]??'',approvedAt:new Date().toISOString()};
const updated=await Data.updateAppointment(id,patch);
if(updated){
await Emailer.onApproved(updated);
const techs = await Data.getTechnicians();
await Emailer.onNewJobAvailable(updated, techs);
}
await loadAdmin();
toast(`✓ Approved — ${updated?.name||''}. Technicians notified by email.`);
}));
document.querySelectorAll('[data-decline]').forEach(el=>el.addEventListener('click',async()=>{
const id=el.dataset.decline;
const patch={status:'declined',adminNote:S.adminNotes[id]??'',declinedAt:new Date().toISOString()};
const updated=await Data.updateAppointment(id,patch);
await loadAdmin();
toast(`Declined — ${updated?.name||''}`,'error');
}));
document.querySelectorAll('[data-propose-alt]').forEach(el=>el.addEventListener('click',async()=>{
const id=el.dataset.proposeAlt;
const altDate=S.adminAltDate[id]||''; const altTime=S.adminAltTime[id]||'';
if(!altDate||!altTime){toast('Please select both an alternative date and time first.','error');return;}
const patch={status:'alt_proposed',altDate,altTime,adminNote:S.adminNotes[id]??'',altProposedAt:new Date().toISOString()};
const updated=await Data.updateAppointment(id,patch);
if(updated) await Emailer.onApproved(updated);
await loadAdmin();
toast(`Alternative time proposed to ${updated?.name||''}`);
}));
document.querySelectorAll('[data-complete]').forEach(el=>el.addEventListener('click',async()=>{
const id=el.dataset.complete;
const patch={status:'completed',completedAt:new Date().toISOString(),adminNote:S.adminNotes[id]??'',pointsAwarded:true};
const updated=await Data.updateAppointment(id,patch);
if(updated){
if(updated.userId){
const users=await Data.getUsers();
const u=users[updated.userId];
if(u) await Data.updateUser(u.id,{points:(u.points||0)+(updated.servicePoints||0)});
}
if(updated.technicianId){
const techs=await Data.getTechnicians();
const tech=techs[updated.technicianId];
if(tech){
const earned = calcTechPayout(updated);
await Data.updateTechnician(tech.id,{ totalEarned:(tech.totalEarned||0)+earned, jobsCompleted:(tech.jobsCompleted||0)+1 });
}
}
await Emailer.onCompleted(updated);
}
await loadAdmin();
toast(`Complete — job marked done, technician earnings credited.`);
}));
document.querySelectorAll('[data-mpts-inp]').forEach(el=>el.addEventListener('input',e=>{S.manualPts[el.dataset.mptsInp]=e.target.value;}));
document.querySelectorAll('[data-award]').forEach(el=>el.addEventListener('click',async()=>{
const uid=el.dataset.award; const pts=parseInt(S.manualPts[uid]||'25');
if(isNaN(pts)||pts<1)return;
const u=S.adminUsers[uid]; if(!u)return;
await Data.updateUser(uid,{points:(u.points||0)+pts});
await loadAdmin();
toast(`Awarded ${pts} pts to ${u.name}`);
}));
document.querySelectorAll('[data-account-create-type]').forEach(el=>el.addEventListener('click',()=>{
S.adminAccountType = el.dataset.accountCreateType; S.adminAccountErr=''; render();
}));
document.getElementById('ac-cust-name')?.addEventListener('input',e=>S.newCustForm.name=e.target.value);
document.getElementById('ac-cust-phone')?.addEventListener('input',e=>S.newCustForm.phone=e.target.value);
document.getElementById('ac-cust-email')?.addEventListener('input',e=>S.newCustForm.email=e.target.value);
document.getElementById('ac-cust-vehicle')?.addEventListener('input',e=>S.newCustForm.vehicle=e.target.value);
document.getElementById('ac-cust-pass')?.addEventListener('input',e=>S.newCustForm.password=e.target.value);
document.getElementById('p-create-customer')?.addEventListener('click', async()=>{
const f=S.newCustForm;
if(!f.name||!f.email||!f.password){S.adminAccountErr='Name, email, and password are required.';render();return;}
if(f.password.length<6){S.adminAccountErr='Password must be at least 6 characters.';render();return;}
const users=await Data.getUsers();
if(Object.values(users).some(u=>u.email.toLowerCase()===f.email.toLowerCase())){S.adminAccountErr='A customer with that email already exists.';render();return;}
const id=genId();
const newUser={id,name:f.name,email:f.email,phone:f.phone,vehicle:f.vehicle,password:f.password,points:100,bookings:[],joinedAt:new Date().toISOString(),membership:false};
await Data.createUser(newUser);
await Emailer.onAccountCreated(newUser);
S.newCustForm={name:'',email:'',phone:'',vehicle:'',password:''}; S.adminAccountErr='';
await loadAdmin();
toast(`Customer account created for "${f.name}". Welcome email sent.`);
});
document.getElementById('ac-fleet-company')?.addEventListener('input',e=>S.newFleetForm.companyName=e.target.value);
document.getElementById('ac-fleet-contact')?.addEventListener('input',e=>S.newFleetForm.contactName=e.target.value);
document.getElementById('ac-fleet-phone')?.addEventListener('input',e=>S.newFleetForm.phone=e.target.value);
document.getElementById('ac-fleet-email')?.addEventListener('input',e=>S.newFleetForm.email=e.target.value);
document.getElementById('ac-fleet-pass')?.addEventListener('input',e=>S.newFleetForm.password=e.target.value);
document.getElementById('p-create-fleet')?.addEventListener('click', async()=>{
const f=S.newFleetForm;
if(!f.companyName||!f.contactName||!f.email||!f.password){S.adminAccountErr='Company name, contact, email, and password are required.';render();return;}
if(f.password.length<6){S.adminAccountErr='Password must be at least 6 characters.';render();return;}
const cos=await Data.getFleetCompanies();
if(Object.values(cos).some(c=>c.email.toLowerCase()===f.email.toLowerCase())){S.adminAccountErr='A fleet account with that email already exists.';render();return;}
const id=genId();
const newCo={id,companyName:f.companyName,contactName:f.contactName,email:f.email,phone:f.phone,password:f.password};
await Data.createFleetCompany(newCo);
await Emailer.onFleetWelcome(newCo);
S.newFleetForm={companyName:'',contactName:'',email:'',phone:'',password:''}; S.adminAccountErr='';
await loadAdmin();
toast(`Fleet account created for "${f.companyName}". They can sign in with that email + password.`);
});
document.getElementById('ac-tech-name')?.addEventListener('input',e=>S.newTechForm.name=e.target.value);
document.getElementById('ac-tech-pin')?.addEventListener('input',e=>S.newTechForm.pin=e.target.value);
document.getElementById('ac-tech-email')?.addEventListener('input',e=>S.newTechForm.email=e.target.value);
document.getElementById('ac-tech-phone')?.addEventListener('input',e=>S.newTechForm.phone=e.target.value);
document.getElementById('p-create-tech')?.addEventListener('click', async()=>{
const f=S.newTechForm;
if(!f.name||!f.pin){S.adminAccountErr='Name and PIN are required.';render();return;}
if(f.pin.length<4){S.adminAccountErr='PIN must be at least 4 characters.';render();return;}
const existing = Object.values(S.adminTechs).find(t=>t.name.toLowerCase()===f.name.toLowerCase());
if(existing){S.adminAccountErr='A technician with that name already exists.';render();return;}
const id = genId();
await Data.createTechnician({id, name:f.name, pin:f.pin, email:f.email, phone:f.phone});
if (f.email) await Emailer.onTechWelcome({name:f.name, email:f.email, pin:f.pin});
S.newTechForm={name:'',pin:'',email:'',phone:''}; S.adminAccountErr='';
await loadAdmin();
toast(`Technician "${f.name}" added! ${f.email?'Welcome email sent. ':''}They can sign in with name + PIN.`);
});
document.getElementById('ac-tow-company')?.addEventListener('input',e=>S.newTowForm.companyName=e.target.value);
document.getElementById('ac-tow-contact')?.addEventListener('input',e=>S.newTowForm.contactName=e.target.value);
document.getElementById('ac-tow-phone')?.addEventListener('input',e=>S.newTowForm.phone=e.target.value);
document.getElementById('ac-tow-email')?.addEventListener('input',e=>S.newTowForm.email=e.target.value);
document.getElementById('ac-tow-pin')?.addEventListener('input',e=>S.newTowForm.pin=e.target.value);
document.getElementById('p-create-tow')?.addEventListener('click', async()=>{
const f=S.newTowForm;
if(!f.companyName||!f.contactName||!f.phone||!f.pin){S.adminAccountErr='Company, contact, phone, and PIN are required.';render();return;}
const id=genId();
await Data.createTowCompany({id,companyName:f.companyName,contactName:f.contactName,phone:f.phone,email:f.email,pin:f.pin});
if (f.email) await Emailer.onTowWelcome({companyName:f.companyName, contactName:f.contactName, email:f.email, pin:f.pin});
S.newTowForm={companyName:'',contactName:'',phone:'',email:'',pin:''}; S.adminAccountErr='';
await loadAdmin();
toast(`Towing partner "${f.companyName}" added. ${f.email?'Welcome email sent.':''}`);
});
document.querySelectorAll('[data-toggle-tech]').forEach(el=>el.addEventListener('click', async()=>{
const id = el.dataset.toggleTech;
const tech = S.adminTechs[id];
if(!tech) return;
await Data.updateTechnician(id, {active: !(tech.active!==false)});
await loadAdmin();
toast(`${tech.name} ${tech.active!==false?'deactivated':'reactivated'}.`);
}));
document.querySelectorAll('[data-verify-tech]').forEach(el=>el.addEventListener('click', async()=>{
const id = el.dataset.verifyTech;
const action = el.dataset.verifyAction;
const tech = S.adminTechs[id];
if(!tech) return;
await Data.updateTechnician(id,{verificationStatus:action});
if(action==='verified')await Data.updateTechnician(id,{jobEligible:true});
if(action==='rejected')await Data.updateTechnician(id,{jobEligible:false});
await Emailer.onTechVerification({name:tech.name,email:tech.email||''},action);
await loadAdmin();
const msg=action==='verified'?`✓ ${tech.name} verified! Email sent.`:action==='rejected'?`${tech.name} rejected. Email sent.`:`${tech.name} reset to pending.`;
toast(msg,action==='rejected'?'error':'success');
}));
document.querySelectorAll('[data-toggle-eligible]').forEach(el=>el.addEventListener('click',async()=>{const id=el.dataset.toggleEligible;const tech=S.adminTechs[id];if(!tech)return;const ne=tech.jobEligible===false;await Data.updateTechnician(id,{jobEligible:ne});await loadAdmin();toast(`${tech.name} is now ${ne?'eligible':'ineligible for new jobs'}.`,ne?'success':'info');}));
document.querySelectorAll('[data-toggle-labor-override]').forEach(el=>el.addEventListener('change',async()=>{const id=el.dataset.toggleLaborOverride;const checked=el.checked;await Data.updateAppointment(id,{useLaborOverride:checked});await loadAdmin();}));
document.querySelectorAll('[data-save-labor-override]').forEach(el=>el.addEventListener('click',async()=>{const id=el.dataset.saveLaborOverride;const input=document.querySelector(`[data-labor-override-val="${id}"]`);const hrs=parseFloat(input?.value||'0');if(!hrs||hrs<=0){toast('Enter a valid hours value.','error');return;}await Data.updateAppointment(id,{laborHoursOverride:hrs,useLaborOverride:true});await loadAdmin();toast('Labor hours override saved.');}));
document.querySelectorAll('[data-payout-amt]').forEach(el=>el.addEventListener('input',e=>{
S.manualPts['payout_'+el.dataset.payoutAmt]=e.target.value;
}));
document.querySelectorAll('[data-payout-tech]').forEach(el=>el.addEventListener('click', async()=>{
const techId = el.dataset.payoutTech;
const amtInput = document.querySelector(`[data-payout-amt="${techId}"]`);
const amt = parseFloat(amtInput?.value||'0');
if(!amt||amt<=0){toast('Enter a payout amount first.','error');return;}
const tech = S.adminTechs[techId];
if(!tech)return;
el.disabled=true; el.textContent='Sending…';
const result = await Payments.payoutTechnician(techId, amt, CONFIG.ADMIN_PIN);
if (!result.success) {
toast(result.error||'Payout failed — technician may not have finished Stripe setup yet.', 'error');
await loadAdmin();
return;
}
const lastJob=Object.values(S.adminAppts||{}).filter(a=>a.technicianId===techId&&a.status==='completed').sort((a,b)=>new Date(b.completedAt||0)-new Date(a.completedAt||0))[0];
await Emailer.onTechPaid(tech,amt,lastJob?.serviceName||'Completed Service');
await loadAdmin();
toast(`✓ Sent ${money(amt)} to ${tech.name}. Payment email sent.`);
}));
document.querySelectorAll('[data-price-labor]').forEach(el=>el.addEventListener('input',e=>{
const id=el.dataset.priceLabor; S.pricingEdits[id]=S.pricingEdits[id]||{}; S.pricingEdits[id].baseLaborHours=parseFloat(e.target.value)||0;
}));
document.querySelectorAll('[data-price-rate]').forEach(el=>el.addEventListener('input',e=>{
const id=el.dataset.priceRate; S.pricingEdits[id]=S.pricingEdits[id]||{}; S.pricingEdits[id].hourlyRate=parseFloat(e.target.value)||0;
}));
document.querySelectorAll('[data-price-parts]').forEach(el=>el.addEventListener('input',e=>{
const id=el.dataset.priceParts; S.pricingEdits[id]=S.pricingEdits[id]||{}; S.pricingEdits[id].avgPartsCost=parseFloat(e.target.value)||0;
}));
document.querySelectorAll('[data-save-pricing]').forEach(el=>el.addEventListener('click', async()=>{
const id=el.dataset.savePricing; const edit=S.pricingEdits[id];
if(!edit){toast('No changes to save.','info');return;}
await Data.updatePricing(id, edit);
delete S.pricingEdits[id];
await loadAdmin();
toast('Pricing updated.');
}));
document.querySelectorAll('[data-fleet-plan-price]').forEach(el=>el.addEventListener('input',e=>{
S.manualPts['fleetplan_'+el.dataset.fleetPlanPrice]=e.target.value;
}));
document.querySelectorAll('[data-fleet-toggle-plan]').forEach(el=>el.addEventListener('click', async()=>{
const id = el.dataset.fleetTogglePlan;
const co = S.adminFleetCos[id];
if(!co)return;
const priceInput = document.querySelector(`[data-fleet-plan-price="${id}"]`);
const price = parseFloat(priceInput?.value||'0');
if (co.monthlyPlan) {
await Data.updateFleetCompany(id, {monthlyPlan:false});
} else {
if(!price||price<=0){toast('Enter a monthly price first.','error');return;}
await Data.updateFleetCompany(id, {monthlyPlan:true, monthlyPlanPrice:price});
}
await loadAdmin();
toast(`Plan ${co.monthlyPlan?'disabled':'enabled'} for ${co.companyName}.`);
}));
document.getElementById('ntw-company')?.addEventListener('input',e=>S.newTowForm.companyName=e.target.value);
document.getElementById('ntw-contact')?.addEventListener('input',e=>S.newTowForm.contactName=e.target.value);
document.getElementById('ntw-phone')?.addEventListener('input',e=>S.newTowForm.phone=e.target.value);
document.getElementById('ntw-pin')?.addEventListener('input',e=>S.newTowForm.pin=e.target.value);
document.getElementById('p-add-tow')?.addEventListener('click', async()=>{
const f=S.newTowForm;
if(!f.companyName||!f.contactName||!f.phone||!f.pin){S.newTowErr='All fields are required.';render();return;}
const id=genId();
await Data.createTowCompany({id,companyName:f.companyName,contactName:f.contactName,phone:f.phone,pin:f.pin});
S.newTowForm={companyName:'',contactName:'',phone:'',pin:''}; S.newTowErr='';
await loadAdmin();
toast(`Towing partner "${f.companyName}" added.`);
});
document.querySelectorAll('[data-toggle-tow]').forEach(el=>el.addEventListener('click', async()=>{
const id=el.dataset.toggleTow; const co=S.adminTowCos[id]; if(!co)return;
await Data.updateTowCompany(id,{active: !(co.active!==false)});
await loadAdmin();
toast(`${co.companyName} ${co.active!==false?'deactivated':'reactivated'}.`);
}));
document.querySelectorAll('[data-finance-range]').forEach(el=>el.addEventListener('click',()=>{
S.financeRange=el.dataset.financeRange; render();
}));
document.querySelectorAll('[data-tech-tab]').forEach(el=>el.addEventListener('click',async()=>{
S.techTab=el.dataset.techTab;render();
if (S.techTab==='earnings' && S.tech) {
S.techConnectStatus = await Payments.checkConnectStatus(S.tech.id);
render();
}
}));
document.querySelectorAll('[data-tech-accept]').forEach(el=>el.addEventListener('click', async()=>{
const id = el.dataset.techAccept;
el.disabled=true; el.textContent='Claiming…';
const claimed=await Data.claimAppointment(id,S.tech.id);
if(claimed){const techFull=S.techAllTechs?.[S.tech.id]||{};if(techFull.email){await Emailer._post('/send-email/job-assigned',{tech:{name:S.tech.name,email:techFull.email},appt:{customerName:claimed.name,vehicle:`${claimed.year} ${claimed.make} ${claimed.model}`,service:claimed.serviceName||claimed.service,date:fmtDate(claimed.date),time:claimed.time,location:claimed.location}});}toast('✓ Job claimed! Check "My Jobs" for details.');await loadTechPortal();}
else{toast('Sorry, another technician already claimed this job.','error');await loadTechPortal();}
}));
document.querySelectorAll('[data-tech-decline]').forEach(el=>el.addEventListener('click', async()=>{
const id = el.dataset.techDecline;
await Data.declineForTech(id, S.tech.id);
render();
toast('Removed from your available jobs list.', 'info');
}));
document.getElementById('p-cal-prev')?.addEventListener('click',()=>{ S.techScheduleMonth = new Date(S.techScheduleMonth.getFullYear(), S.techScheduleMonth.getMonth()-1, 1); render(); });
document.getElementById('p-cal-next')?.addEventListener('click',()=>{ S.techScheduleMonth = new Date(S.techScheduleMonth.getFullYear(), S.techScheduleMonth.getMonth()+1, 1); render(); });
document.querySelectorAll('[data-job-detail]').forEach(el=>el.addEventListener('click',()=>{ S.techTab='myjobs'; render(); }));
document.getElementById('tp-photo')?.addEventListener('input',e=>{S.techVerifyForm.photoUrl=e.target.value;});
document.getElementById('tp-vyear')?.addEventListener('input',e=>{S.techVerifyForm.vehicleYear=e.target.value;});
document.getElementById('tp-vmake')?.addEventListener('input',e=>{S.techVerifyForm.vehicleMake=e.target.value;});
document.getElementById('tp-vmodel')?.addEventListener('input',e=>{S.techVerifyForm.vehicleModel=e.target.value;});
document.getElementById('p-save-profile')?.addEventListener('click', async()=>{
const f=S.techVerifyForm;
const patch={};
if(f.photoUrl!==undefined)patch.photoUrl=f.photoUrl;
if(f.vehicleYear!==undefined)patch.vehicleYear=f.vehicleYear;
if(f.vehicleMake!==undefined)patch.vehicleMake=f.vehicleMake;
if(f.vehicleModel!==undefined)patch.vehicleModel=f.vehicleModel;
await Data.updateTechnician(S.tech.id, patch);
await loadTechPortal();
toast('Profile updated.');
});
document.getElementById('tp-iddoc')?.addEventListener('input',e=>{S.techVerifyForm.idDocUrl=e.target.value;});
document.getElementById('tp-insdoc')?.addEventListener('input',e=>{S.techVerifyForm.insuranceDocUrl=e.target.value;});
document.getElementById('tp-asecert')?.addEventListener('input',e=>{S.techVerifyForm.aseCertUrl=e.target.value;});
document.getElementById('tp-equip')?.addEventListener('input',e=>{S.techVerifyForm.equipmentPhotoUrl=e.target.value;});
document.getElementById('p-save-verification')?.addEventListener('click', async()=>{
const f=S.techVerifyForm;
const patch={verificationStatus:'pending'};
if(f.idDocUrl!==undefined)patch.idDocUrl=f.idDocUrl;
if(f.insuranceDocUrl!==undefined)patch.insuranceDocUrl=f.insuranceDocUrl;
if(f.aseCertUrl!==undefined)patch.aseCertUrl=f.aseCertUrl;
if(f.equipmentPhotoUrl!==undefined)patch.equipmentPhotoUrl=f.equipmentPhotoUrl;
await Data.updateTechnician(S.tech.id, patch);
await loadTechPortal();
toast('Documents submitted for verification. Robert will review and approve.');
});
document.querySelectorAll('[data-clock-start]').forEach(el=>el.addEventListener('click',async()=>{
const id=el.dataset.clockStart;el.disabled=true;el.textContent='…';
try{const r=await fetch(`${CONFIG.BACKEND_URL}/time-clock/start`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({appointmentId:id,technicianId:S.tech.id})});const d=await r.json();if(!r.ok)throw new Error(d.error||'Failed.');S.activeClockLog={id:d.logId,appointment_id:id};toast('⏱ Clocked in.');await loadTechPortal();}
catch(e){toast(e.message,'error');el.disabled=false;el.textContent='▶ Clock In';}
}));
document.querySelectorAll('[data-clock-stop]').forEach(el=>el.addEventListener('click',async()=>{
if(!S.activeClockLog){toast('No active clock.','error');return;}
const id=el.dataset.clockStop;el.disabled=true;el.textContent='…';
try{const r=await fetch(`${CONFIG.BACKEND_URL}/time-clock/stop`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({logId:S.activeClockLog.id})});const d=await r.json();if(!r.ok)throw new Error(d.error||'Failed.');S.activeClockLog=null;const tr=await fetch(`${CONFIG.BACKEND_URL}/time-clock/job/${id}`);const td=await tr.json();await Data.updateAppointment(id,{actualClockedSeconds:td.totalSeconds||0});toast(`⏸ Clocked out: ${fmtDuration(td.totalSeconds||0)}`);await loadTechPortal();}
catch(e){toast(e.message,'error');el.disabled=false;el.textContent='⏸ Clock Out';}
}));
document.getElementById('p-tech-onboard')?.addEventListener('click', async()=>{
const btn = document.getElementById('p-tech-onboard');
if(btn){btn.disabled=true; btn.textContent='Loading…';}
S.paymentErr='';
let email = S.techAllTechs[S.tech.id]?.email;
if (!email) {
email = prompt('Enter your email address for payout setup:');
if (!email) { if(btn){btn.disabled=false;btn.textContent='Set Up Payouts →';} return; }
}
const result = await Payments.startTechOnboarding(S.tech.id, email, S.tech.name);
if (!result.success) {
S.paymentErr = result.error; render();
return;
}
window.location.href = result.url; // redirect to Stripe-hosted onboarding
});
document.getElementById('p-share-location')?.addEventListener('click', ()=>{
if(!navigator.geolocation){toast('Location services not available on this device.','error');return;}
navigator.geolocation.getCurrentPosition(async pos=>{
await Data.updateTechnician(S.tech.id,{lat:pos.coords.latitude, lng:pos.coords.longitude, locationUpdatedAt:new Date().toISOString()});
await loadTechPortal();
toast('Location updated! Customers can now see your distance.');
}, err=>{ toast('Could not get location: '+err.message,'error'); });
});
document.querySelectorAll('[data-fleet-tab]').forEach(el=>el.addEventListener('click',()=>{S.fleetTab=el.dataset.fleetTab;render();}));
// Vehicle form inputs
['nv-year','nv-make','nv-model','nv-nick','nv-vin','nv-mileage'].forEach(id=>{
document.getElementById(id)?.addEventListener('input',e=>{
const k={'nv-year':'year','nv-make':'make','nv-model':'model','nv-nick':'nickname','nv-vin':'vin','nv-mileage':'mileage'}[id];
if(k&&S.fleetVehicleForm)S.fleetVehicleForm[k]=e.target.value;
});
});
// Add vehicle button
document.getElementById('p-add-vehicle')?.addEventListener('click',async()=>{
const f=S.fleetVehicleForm||{};S.fleetVehicleErr='';
if(!f.year||!f.make||!f.model){S.fleetVehicleErr='Year, make and model are required.';render();return;}
S.loading=true;render();
const id=genId();
await Data.createFleetVehicle({id,companyId:S.fleet.id,year:f.year,make:f.make,model:f.model,nickname:f.nickname||'',vin:f.vin||'',mileage:f.mileage?Number(f.mileage):null,active:true,createdAt:new Date().toISOString()});
S.fleetVehicleForm={year:'',make:'',model:'',vin:'',nickname:'',mileage:''};
S.loading=false;await loadFleetPortal();toast('Vehicle added to fleet.');
});
// Pick vehicle for booking
document.querySelectorAll('[data-fleet-pick-vehicle]').forEach(el=>el.addEventListener('click',()=>{
S.fleetBooking.vehicleId=el.dataset.fleetPickVehicle;
document.getElementById('p-fleet-step1-next')?.removeAttribute('disabled');
render();
}));
// Book from vehicle card shortcut
document.querySelectorAll('[data-fleet-book-vehicle]').forEach(el=>el.addEventListener('click',()=>{
S.fleetBooking={vehicleId:el.dataset.fleetBookVehicle,services:[],date:'',time:'8:00 AM',location:'',notes:'',rush:false,emergency:false};
S.fleetSvcSearch='';S.fleetBookStep=2;S.fleetBookDone=false;S.fleetTab='book';render();
}));
// Step 1 next
document.getElementById('p-fleet-step1-next')?.addEventListener('click',()=>{if(!S.fleetBooking.vehicleId)return;S.fleetBookStep=2;S.fleetSvcSearch='';render();});
// Service search
document.getElementById('fleet-svc-search')?.addEventListener('input',e=>{S.fleetSvcSearch=e.target.value;render();});
// Toggle service selection
document.querySelectorAll('[data-fleet-toggle-svc]').forEach(el=>el.addEventListener('click',()=>{
const sid=el.dataset.fleetToggleSvc;
const idx=S.fleetBooking.services.indexOf(sid);
if(idx>=0)S.fleetBooking.services.splice(idx,1);else S.fleetBooking.services.push(sid);
render();
}));
// Step 2 back/next
document.getElementById('p-fleet-step2-back')?.addEventListener('click',()=>{S.fleetBookStep=1;render();});
document.getElementById('p-fleet-step2-next')?.addEventListener('click',()=>{if(S.fleetBooking.services.length===0)return;S.fleetBookStep=3;render();});
// Step 3 inputs
['fb-date','fb-time','fb-location','fb-notes'].forEach(id=>{
document.getElementById(id)?.addEventListener('input',e=>{
const k={'fb-date':'date','fb-time':'time','fb-location':'location','fb-notes':'notes'}[id];
if(k)S.fleetBooking[k]=e.target.value;
});
});
// Step 3 back
document.getElementById('p-fleet-step3-back')?.addEventListener('click',()=>{S.fleetBookStep=2;render();});
// Step 3 submit — create one appointment per service
document.getElementById('p-fleet-step3-submit')?.addEventListener('click',async()=>{
const b=S.fleetBooking;S.fleetBookErr='';
if(!b.date){S.fleetBookErr='Please select a date.';render();return;}
if(!b.location){S.fleetBookErr='Please enter the service location.';render();return;}
S.loading=true;render();
const sub=S.fleetSub;
const veh=S.fleetVehicles.find(v=>v.id===b.vehicleId);
const co=S.fleetCompany||S.fleet;
for(const sid of b.services){
const svc=SERVICES.find(s=>s.id===sid);if(!svc)continue;
const id=genId();
const laborHrs=svc.hours;
const laborAmt=laborHrs*100;
const appt={
id,name:co.contactName||co.companyName,email:co.email,phone:co.phone||'',
year:veh?.year||'',make:veh?.make||'',model:veh?.model||'',
service:sid,serviceName:svc.label,servicePoints:30,
date:b.date,time:b.time,location:b.location,notes:b.notes||'',
rush:false,emergency:false,partsChoice:'parts',
status:'pending',createdAt:new Date().toISOString(),
fleetCompanyId:S.fleet.id,fleetVehicleId:b.vehicleId,
estimatedPrice:sub?0:laborAmt,
laborHours:laborHrs,
laborCoveredBySubscription:!!sub,
fleetSubscriptionId:sub?sub.id:null,
partsDiscountPct:sub?sub.parts_discount_pct:0,
services:[sid],
};
await Data.createAppointment(appt);
}
// Notify admin
await Promise.all([
Emailer.onBooking({...S.fleetBooking,name:co.contactName||co.companyName,email:co.email,phone:co.phone||'',year:veh?.year||'',make:veh?.make||'',model:veh?.model||'',service:b.services[0],estimatedPrice:0}),
]);
S.loading=false;S.fleetBookDone=true;render();await loadFleetPortal();
});
// Book another
document.getElementById('p-fleet-book-another')?.addEventListener('click',()=>{
S.fleetBooking={vehicleId:'',services:[],date:'',time:'8:00 AM',location:'',notes:''};
S.fleetBookStep=1;S.fleetBookDone=false;render();
});
// FleetCare subscribe
document.querySelectorAll('[data-subscribe-plan]').forEach(el=>el.addEventListener('click',async()=>{
const planId=el.dataset.subscribePlan;
if(planId==='enterprise'){
toast('Contact Robert at (251) 289-0740 for Enterprise pricing.');return;
}
S.fleetPlanSelected=planId;
document.getElementById('fleet-stripe-card-container').style.display='block';
await Payments.mountCardElement('fleet-card-element');
el.scrollIntoView({behavior:'smooth'});
}));
// Confirm fleet subscription payment
document.getElementById('p-confirm-fleet-sub')?.addEventListener('click',async()=>{
const btn=document.getElementById('p-confirm-fleet-sub');
if(btn){btn.disabled=true;btn.textContent='Processing…';}
S.fleetSubErr='';
const co=S.fleet;
const payResult=await Payments.payForAppointment('fleet_sub_'+Date.now(),0.50,co.email,co.companyName);
if(!payResult.success&&!payResult.paymentMethodId){
S.fleetSubErr=payResult.error||'Payment failed.';render();if(btn){btn.disabled=false;btn.textContent='Confirm Subscription';}return;
}
try{
const r=await fetch(`${CONFIG.BACKEND_URL}/fleetcare/subscribe`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fleetCompanyId:co.id,planId:S.fleetPlanSelected,paymentMethodId:payResult.paymentMethodId||'',email:co.email,companyName:co.companyName})});
const d=await r.json();if(!r.ok)throw new Error(d.error||'Subscription failed.');
S.fleetSubDone=true;await loadFleetPortal();toast('FleetCare plan activated!');
}catch(e){S.fleetSubErr=e.message;render();if(btn){btn.disabled=false;btn.textContent='Confirm Subscription';}}
});
document.getElementById('p-cancel-fleet-sub-form')?.addEventListener('click',()=>{
document.getElementById('fleet-stripe-card-container').style.display='none';
Payments.unmountCardElement();
});
// Cancel active FleetCare plan
document.getElementById('p-cancel-fleetcare')?.addEventListener('click',async()=>{
if(!confirm('Cancel your FleetCare plan? This cannot be undone.'))return;
const sub=S.fleetSub;if(!sub)return;
try{
const r=await fetch(`${CONFIG.BACKEND_URL}/fleetcare/cancel`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subId:sub.id,fleetCompanyId:S.fleet.id})});
const d=await r.json();if(!r.ok)throw new Error(d.error||'Cancel failed.');
S.fleetSub=null;await loadFleetPortal();toast('Plan cancelled.');
}catch(e){toast(e.message,'error');}
});
document.getElementById('nv-year')?.addEventListener('input',e=>S.newVehicleForm.year=e.target.value);
document.getElementById('nv-make')?.addEventListener('input',e=>S.newVehicleForm.make=e.target.value);
document.getElementById('nv-model')?.addEventListener('input',e=>S.newVehicleForm.model=e.target.value);
document.getElementById('nv-nick')?.addEventListener('input',e=>S.newVehicleForm.nickname=e.target.value);
document.getElementById('nv-vin')?.addEventListener('input',e=>S.newVehicleForm.vin=e.target.value);
document.getElementById('p-add-vehicle')?.addEventListener('click', async()=>{
const f=S.newVehicleForm;
if(!f.year||!f.make||!f.model){toast('Year, make, and model are required.','error');return;}
const id=genId();
await Data.createFleetVehicle({id, companyId:S.fleet.id, year:f.year, make:f.make, model:f.model, nickname:f.nickname, vin:f.vin});
S.newVehicleForm={year:'',make:'',model:'',nickname:'',vin:''};
await loadFleetPortal();
toast('Vehicle added to fleet.');
});
document.querySelectorAll('[data-fleet-book-vehicle]').forEach(el=>el.addEventListener('click',()=>{
S.fleetBookingVehicle = el.dataset.fleetBookVehicle; render();
}));
document.getElementById('p-fleetbook-cancel')?.addEventListener('click',()=>{ S.fleetBookingVehicle=null; render(); });
document.getElementById('p-fleetbook-submit')?.addEventListener('click', async()=>{
const v = S.fleetVehicles.find(x=>x.id===S.fleetBookingVehicle);
const svcEl=document.getElementById('fb-service'); const dateEl=document.getElementById('fb-date');
const timeEl=document.getElementById('fb-time'); const locEl=document.getElementById('fb-location'); const notesEl=document.getElementById('fb-notes');
if(!svcEl.value||!dateEl.value||!timeEl.value||!locEl.value){toast('Please fill in service, date, time, and location.','error');return;}
const svc=SERVICES.find(s=>s.id===svcEl.value);
const id=genId();
const appt={id, year:v.year, make:v.make, model:v.model, service:svcEl.value, serviceName:svc?.label||svcEl.value,
repairDesc:notesEl.value||'', rush:false, emergency:false, partsChoice:'order', date:dateEl.value, time:timeEl.value,
name:S.fleet.contactName, email:S.fleet.email, phone:S.fleet.phone||'', location:locEl.value, notes:notesEl.value||'',
status:'pending', createdAt:new Date().toISOString(), userId:null, pointsAwarded:false, adminNote:'',
servicePoints:PTS_MAP[svcEl.value]||30, estimatedPrice:0, fleetCompanyId:S.fleet.id, fleetVehicleId:v.id};
await Data.createAppointment(appt);
S.fleetBookingVehicle=null;
await loadFleetPortal();
toast('Service request submitted for review.');
});
document.getElementById('p-request-fleet-plan')?.addEventListener('click', async()=>{
await SMS.sendToAdmin({name:S.fleet.contactName, phone:S.fleet.phone||'N/A', year:'',make:'Fleet Plan Request',model:S.fleet.companyName, service:'fleet', date:todayStr(), time:'N/A', location:'N/A', rush:false});
toast('Quote request sent to Robert! He will follow up directly.');
});
document.querySelectorAll('[data-tow-tab]').forEach(el=>el.addEventListener('click',()=>{S.towTab=el.dataset.towTab;render();}));
document.querySelectorAll('[data-tow-accept]').forEach(el=>el.addEventListener('click', async()=>{
const id=el.dataset.towAccept;
el.disabled=true; el.textContent='Claiming…';
const claimed = await Data.claimTowRequest(id, S.tow.id);
if(claimed){ toast('✓ Tow job claimed!'); await loadTowPortal(); }
else { toast('Another company already claimed this request.','error'); await loadTowPortal(); }
}));
document.querySelectorAll('[data-tow-complete]').forEach(el=>el.addEventListener('click', async()=>{
const id=el.dataset.towComplete;
await Data.updateTowRequest(id,{status:'completed', completedAt:new Date().toISOString()});
await loadTowPortal();
toast('Tow marked complete.');
}));
}
async function loadTimeSlots(){
const wrap=document.getElementById('p-time-slots');
if(!wrap)return;
const allAppts=await Data.getAppointments();
const taken={};
Object.values(allAppts).forEach(a=>{ if(a.status!=='declined'){const k=`${a.date}_${a.time}`;taken[k]=(taken[k]||0)+1;} });
wrap.innerHTML=`<div class="ptimegrid">${TIME_SLOTS.map(t=>{
const bk=(taken[`${S.booking.date}_${t}`]||0)>=2;
const sel=S.booking.time===t;
return `<button class="ptbtn ${sel?'sel':''}" ${bk?'disabled':''} data-time="${t}">${bk?`<s>${t}</s>`:t}</button>`;
}).join('')}</div>`;
wrap.querySelectorAll('[data-time]').forEach(el=>el.addEventListener('click',()=>{
S.booking.time=el.dataset.time;
const next=document.getElementById('p-s3-next');
if(next) next.disabled=!(S.booking.date&&S.booking.time);
wrap.querySelectorAll('.ptbtn').forEach(b=>b.classList.remove('sel'));
el.classList.add('sel');
}));
}
async function doLogin(){
S.loading=true; render();
const users=await Data.getUsers();
const u=Object.values(users).find(u=>u.email.toLowerCase()===S.loginForm.email.toLowerCase());
S.loading=false;
if(!u){S.loginErr='No account found with that email.';render();return;}
if(u.password!==S.loginForm.pass){S.loginErr='Incorrect password.';render();return;}
Session.set({uid:u.id}); S.user=u; S.loginErr='';
nav('dashboard');
toast(`Welcome back, ${u.name.split(' ')[0]}!`);
}
async function doTechLogin(){
S.loading=true; render();
const techs = await Data.getTechnicians();
const match = Object.values(techs).find(t => t.name.toLowerCase()===S.loginForm.techId.toLowerCase() && t.pin===S.loginForm.techPin);
S.loading=false;
if (!match) { S.loginErr='Name or PIN incorrect.'; render(); return; }
if (match.active===false) { S.loginErr='This technician account is inactive. Contact Robert.'; render(); return; }
Session.setTech({id:match.id, name:match.name});
S.tech = {id:match.id, name:match.name};
S.loginErr='';
nav('techportal');
toast(`Welcome, ${match.name}!`);
}
async function doFleetLogin(){
S.loading=true; render();
const cos = await Data.getFleetCompanies();
const match = Object.values(cos).find(c => c.email.toLowerCase()===S.loginForm.fleetEmail.toLowerCase());
S.loading=false;
if (!match) { S.loginErr='No fleet account found with that email.'; render(); return; }
if (match.password !== S.loginForm.fleetPass) { S.loginErr='Incorrect password.'; render(); return; }
Session.setFleet({id:match.id, companyName:match.companyName, contactName:match.contactName, email:match.email, phone:match.phone});
S.fleet = {id:match.id, companyName:match.companyName, contactName:match.contactName, email:match.email, phone:match.phone};
S.loginErr='';
nav('fleetportal');
toast(`Welcome, ${match.companyName}!`);
}
async function doTowLogin(){
S.loading=true; render();
const cos = await Data.getTowCompanies();
const match = Object.values(cos).find(c => c.phone===S.loginForm.towPhone && c.pin===S.loginForm.towPin);
S.loading=false;
if (!match) { S.loginErr='Phone or PIN incorrect.'; render(); return; }
if (match.active===false) { S.loginErr='This account is inactive. Contact Robert.'; render(); return; }
Session.setTow({id:match.id, companyName:match.companyName});
S.tow = {id:match.id, companyName:match.companyName};
S.loginErr='';
nav('towportal');
toast(`Welcome, ${match.companyName}!`);
}
async function doRegister(){
const f=S.regForm;
if(!f.name||!f.email||!f.password){S.regErr='Name, email, and password are required.';render();return;}
if(f.password!==f.confirm){S.regErr="Passwords don't match.";render();return;}
if(f.password.length<6){S.regErr='Password must be at least 6 characters.';render();return;}
S.loading=true; render();
const users=await Data.getUsers();
if(Object.values(users).some(u=>u.email.toLowerCase()===f.email.toLowerCase())){S.loading=false;S.regErr='An account with that email already exists.';render();return;}
const id=genId();
const newUser={id,name:f.name,email:f.email,phone:f.phone,vehicle:f.vehicle,password:f.password,points:100,bookings:[],joinedAt:new Date().toISOString(),membership:false};
await Data.createUser(newUser);
Session.set({uid:id}); S.user=newUser; S.regErr=''; S.loading=false;
await Emailer.onAccountCreated(newUser);
nav('dashboard');
toast(`Welcome, ${f.name.split(' ')[0]}! You earned 100 welcome points `);
}
async function doFleetRegister(){
const f=S.fleetRegForm;
if(!f.companyName||!f.contactName||!f.email||!f.password){S.fleetRegErr='Company name, contact, email, and password are required.';render();return;}
if(f.password!==f.confirm){S.fleetRegErr="Passwords don't match.";render();return;}
if(f.password.length<6){S.fleetRegErr='Password must be at least 6 characters.';render();return;}
S.loading=true; render();
const cos=await Data.getFleetCompanies();
if(Object.values(cos).some(c=>c.email.toLowerCase()===f.email.toLowerCase())){S.loading=false;S.fleetRegErr='A fleet account with that email already exists.';render();return;}
const id=genId();
const newCo={id,companyName:f.companyName,contactName:f.contactName,email:f.email,phone:f.phone,password:f.password};
await Data.createFleetCompany(newCo);
Session.setFleet({id, companyName:f.companyName, contactName:f.contactName, email:f.email, phone:f.phone});
S.fleet={id, companyName:f.companyName, contactName:f.contactName, email:f.email, phone:f.phone};
S.fleetRegErr=''; S.loading=false;
nav('fleetportal');
toast(`Welcome, ${f.companyName}! Add your fleet vehicles to get started.`);
}
async function loadDashboard(){
if(!S.user)return;
S.loading=true; render();
const users=await Data.getUsers();
const fresh=users[S.user.id];
if(fresh) S.user=fresh;
const allAppts=await Data.getAppointments();
S.dashAppts=Object.values(allAppts).filter(a=>a.userId===S.user.id).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
S.loading=false; render();
}
async function loadAdmin(){
S.loading=true; render();
const [appts,users,techs,pricing,fleetCos,fleetVehicles,towCos,towReqs,payouts]=await Promise.all([
Data.getAppointments(),Data.getUsers(),Data.getTechnicians(),Data.getPricing(),
Data.getFleetCompanies(),Data.getFleetVehicles(),Data.getTowCompanies(),Data.getTowRequests(),Data.getPayouts()
]);
S.adminAppts=Object.values(appts).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
S.adminUsers=users; S.adminTechs=techs; S.adminPricing=pricing;
S.adminFleetCos=fleetCos; S.adminFleetVehicles=fleetVehicles;
S.adminTowCos=towCos; S.adminTowReqs=towReqs; S.adminPayouts=payouts;
S.loading=false; render();
}
async function loadTechPortal(){
if(!S.tech)return;
S.loading=true; render();
const [appts,techs]=await Promise.all([Data.getAppointments(),Data.getTechnicians()]);
S.techAllAppts=Object.values(appts).sort((a,b)=>new Date(a.date)-new Date(b.date));
S.techAllTechs=techs;
try{
const r=await fetch(`${CONFIG.BACKEND_URL}/time-clock/active/${S.tech.id}`);
const d=await r.json();
S.activeClockLog=d.active||null;
}catch(e){S.activeClockLog=null;}
S.loading=false; render();
}
async function loadFleetPortal(){
if(!S.fleet)return;
S.loading=true; render();
const [vehicles,appts]=await Promise.all([Data.getFleetVehicles(),Data.getAppointments()]);
S.fleetVehicles=Object.values(vehicles).filter(v=>v.companyId===S.fleet.id&&v.active!==false);
try{const sr=await fetch(`${CONFIG.BACKEND_URL}/fleetcare/subscription/${S.fleet.id}`);const sd=await sr.json();S.fleetSub=sd.subscription||null;}catch(e){S.fleetSub=null;}
S.fleetAppts=Object.values(appts).filter(a=>a.fleetCompanyId===S.fleet.id);
const coData = await Data.getFleetCompanies();
if (coData[S.fleet.id]) S.fleet = {...S.fleet, ...coData[S.fleet.id]};
S.loading=false; render();
}
async function loadTowPortal(){
if(!S.tow)return;
S.loading=true; render();
const reqs=await Data.getTowRequests();
S.towAllReqs=Object.values(reqs).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
S.loading=false; render();
}
async function loadPricing(){
S.pricing = await Data.getPricing();
}
async function loadFleetPlans(){
try{const r=await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/uea_fleet_plans?active=eq.true&order=sort_order.asc`,{headers:SB.headers()});const rows=await r.json();S.fleetPlans=(rows||[]).map(p=>({id:p.id,name:p.name,vehicleMin:p.vehicle_min,vehicleMax:p.vehicle_max,monthlyPrice:p.monthly_price,partsDiscountPct:p.parts_discount_pct,laborHoursCap:p.labor_hours_cap_per_vehicle,stripePriceId:p.stripe_price_id}));}catch(e){S.fleetPlans=[];}
}
async function loadServices(){
try{
const r=await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/uea_services?active=eq.true&order=sort_order.asc`,{headers:SB.headers()});
const rows=await r.json();
SERVICES=rows.map(r=>({id:r.id,label:r.label,diag:r.is_diagnostic,hours:Number(r.base_labor_hours),rate:Number(r.hourly_rate),partsCost:Number(r.avg_parts_cost),cat:r.category,note:r.note}));
PTS_MAP={}; SERVICES.forEach(s=>{PTS_MAP[s.id]=rows.find(r=>r.id===s.id)?.loyalty_points||30;});
}catch(e){console.warn('Failed to load services, using fallback',e);
SERVICES=[{id:'diag_engine',label:'Check Engine Light Diagnosis',diag:true,hours:1,rate:100,partsCost:0,cat:'Diagnostics'},{id:'other',label:'Other — Describe Below',diag:false,hours:1.5,rate:100,partsCost:0,cat:'Other'}];
PTS_MAP={diag_engine:30,other:50};
}
}
async function boot(){
await Promise.all([loadPricing(), loadServices(), loadFleetPlans()]);
render();
const sess=Session.get();
if (sess?.uid) {
Data.getUsers().then(users=>{
if(users[sess.uid]){ S.user=users[sess.uid]; if(S.view==='dashboard') loadDashboard(); }
});
}
const techSess = Session.getTech();
if (techSess) { S.tech = techSess; }
const fleetSess = Session.getFleet();
if (fleetSess) { S.fleet = fleetSess; }
const towSess = Session.getTow();
if (towSess) { S.tow = towSess; }
}
function navWithLoad(view){
S.view=view;
if(view==='book'){
S.bookStep=1;S.bookDone=false;S._cardMounted=false;
S.booking={year:'',make:'',model:'',service:'',repairDesc:'',rush:false,emergency:false,partsChoice:'',date:'',time:'',name:S.user?.name||'',email:S.user?.email||'',phone:S.user?.phone||'',location:''};
S.veh={makes:[],models:[],loadingMakes:false,loadingModels:false};
}
if(view==='tow'){ S.towDone=false; }
render();
if (view==='dashboard') loadDashboard();
if (view==='admin') loadAdmin();
if (view==='techportal') loadTechPortal();
if (view==='fleetportal') loadFleetPortal();
if (view==='towportal') loadTowPortal();
setTimeout(()=>document.getElementById('ueaportal')?.scrollIntoView({behavior:'smooth',block:'start'}),50);
}
nav = navWithLoad;
if (document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot);
else boot();
