// Formulário público de confirmação de pagamento — hospedado no GitHub
// Pages, sem servidor próprio. Grava direto no Supabase (chave "anon
// public" — só INSERT em formularios_pagamento, graças ao RLS de
// supabase/schema-formulario-pagamento.sql). A lista de pagamentos vem de
// pagamentos-snapshot.json, publicado pela plataforma local da campanha
// (Agenda de Pagamento -> "Publicar lista para formulário"). Contém nome,
// telefone, endereço, função e localidade (para o responsável em campo
// identificar a pessoa), mas NUNCA chave PIX nem CPF. O sistema local
// importa os envios como lançamentos de despesa.

const SEM_LOCALIDADE = 'Sem localidade';

const supabaseClient = window.supabase.createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey);

// Itens do snapshot já filtrados pela lista da equipe.
let itens = [];
const enviados = {}; // token -> true depois de registrado com sucesso
let listaAtiva = null;

// Mesma regra de lib/pagamentoFormulario.js#filtrarItensPorLocalidades —
// reimplementada porque o formulário público tem deploy isolado.
function filtrarItensPorLocalidades(lista, localidades) {
    if (!localidades || !localidades.length) return lista.slice();
    const permitidas = new Set(localidades.map(l => String(l)));
    return lista.filter(it => permitidas.has(String(it.local_prestacao || SEM_LOCALIDADE)));
}

// ---------- helpers ----------
function mascararData(valor) {
    return String(valor || '').replace(/\D/g, '').slice(0, 8)
        .replace(/(\d{2})(\d)/, '$1/$2')
        .replace(/(\d{2}\/\d{2})(\d)/, '$1/$2');
}

function dataParaISO(valor) {
    const m = String(valor || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) return null;
    const [, dd, mm, aaaa] = m;
    const d = new Date(Number(aaaa), Number(mm) - 1, Number(dd));
    if (d.getFullYear() !== Number(aaaa) || d.getMonth() !== Number(mm) - 1 || d.getDate() !== Number(dd)) return null;
    return `${aaaa}-${mm}-${dd}`;
}

function hojeBR() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function isoParaBR(iso) {
    const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso || '—');
}

function fmtMoeda(v) {
    return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function localidadeDoItem(it) {
    return it.local_prestacao || SEM_LOCALIDADE;
}

function rotuloFuncao(f) {
    if (f === 'lider') return 'Líder';
    if (f === 'multiplicador') return 'Multiplicador';
    if (f === 'fiscalizacao') return 'Fiscalização';
    return f || '';
}

// Bloco de identificação da pessoa (função · localidade / telefone · endereço)
// mostrado abaixo do nome, para o responsável em campo achar quem é.
function detalhePessoa(it) {
    const linha1 = [rotuloFuncao(it.funcao), it.local_prestacao].filter(Boolean).join(' · ');
    const contato = [
        it.telefone ? `📞 ${it.telefone}` : '',
        it.endereco ? `🏠 ${it.endereco}` : ''
    ].filter(Boolean).join(' · ');
    return [linha1, contato].filter(Boolean).join('<br>');
}

function agruparPorLocalidade(lista) {
    const grupos = [];
    lista.forEach(it => {
        const loc = localidadeDoItem(it);
        const ultimo = grupos[grupos.length - 1];
        if (ultimo && ultimo.localidade === loc) ultimo.itens.push(it);
        else grupos.push({ localidade: loc, itens: [it] });
    });
    return grupos;
}

// ---------- mensagens ----------
function mostrarMensagem(texto, tipo) {
    const el = document.getElementById('pg-mensagem');
    el.textContent = texto;
    el.className = `fp-msg ${tipo}`;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function limparMensagem() {
    const el = document.getElementById('pg-mensagem');
    el.textContent = '';
    el.className = 'fp-msg';
}

// ---------- render ----------
function linhaId(token) { return `pg-linha-${token}`; }

function renderTabelas() {
    const container = document.getElementById('pg-tabelas');

    if (itens.length === 0) {
        container.innerHTML = '<div class="fp-msg info" style="display:block;">Nenhum pagamento pendente para esta equipe. Fale com a administração da campanha.</div>';
        return;
    }

    const ordenados = [...itens].sort((a, b) => {
        const la = localidadeDoItem(a);
        const lb = localidadeDoItem(b);
        if (la !== lb) return la.localeCompare(lb, 'pt-BR');
        if (a.data_prevista !== b.data_prevista) return a.data_prevista < b.data_prevista ? -1 : 1;
        return (a.nome || '').localeCompare(b.nome || '', 'pt-BR');
    });

    const grupos = agruparPorLocalidade(ordenados);
    container.innerHTML = grupos.map(g => `
        <div class="pg-grupo" data-localidade="${encodeURIComponent(g.localidade)}">
            <div class="pg-localidade-titulo">${g.localidade}</div>
            <div class="pg-tabela-wrap">
                <table class="pg-tabela">
                    <thead>
                        <tr><th>Pessoa</th><th>Valor</th><th>Data prevista</th><th>Parcela</th><th></th></tr>
                    </thead>
                    <tbody>
                        ${g.itens.map(it => `
                            <tr id="${linhaId(it.token)}" data-token="${it.token}">
                                <td>
                                    <strong>${it.nome}</strong>
                                    ${detalhePessoa(it) ? `<div class="pg-pessoa-detalhe">${detalhePessoa(it)}</div>` : ''}
                                </td>
                                <td>${fmtMoeda(it.valor)}</td>
                                <td>${isoParaBR(it.data_prevista)}</td>
                                <td>${it.parcela || '—'}/${it.total_parcelas || '—'}</td>
                                <td><button type="button" class="btn-primary pg-btn-linha" data-token="${it.token}">Registrar pagamento</button></td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        </div>
    `).join('');

    container.querySelectorAll('.pg-btn-linha').forEach(btn =>
        btn.addEventListener('click', () => registrarLinha(btn.dataset.token)));

    aplicarFiltroLocalidade();
}

function preencherFiltroLocalidades() {
    const select = document.getElementById('pg-filtro-localidade');
    const vistas = [];
    itens.forEach(it => {
        const loc = localidadeDoItem(it);
        if (!vistas.includes(loc)) vistas.push(loc);
    });
    vistas.sort((a, b) => a.localeCompare(b, 'pt-BR'));
    vistas.forEach(loc => {
        const opt = document.createElement('option');
        opt.value = loc; opt.textContent = loc;
        select.appendChild(opt);
    });
    if (listaAtiva && vistas.length <= 1) {
        select.closest('.form-group').style.display = 'none';
    }
}

function aplicarFiltroLocalidade() {
    const alvo = document.getElementById('pg-filtro-localidade').value;
    document.querySelectorAll('.pg-grupo').forEach(g => {
        const loc = decodeURIComponent(g.dataset.localidade);
        g.style.display = (!alvo || alvo === loc) ? '' : 'none';
    });
}

// ---------- validação / envio ----------
function validarCabecalho() {
    const dataISO = dataParaISO(document.getElementById('pg-data').value);
    if (!dataISO) return 'Informe a Data do pagamento no formato DD/MM/AAAA.';
    if (!document.getElementById('pg-confirmado-por').value.trim()) return 'Informe quem está confirmando os pagamentos.';
    return null;
}

function itemPorToken(token) {
    return itens.find(it => it.token === token) || null;
}

async function persistirLinha(token) {
    const it = itemPorToken(token);
    const dataISO = dataParaISO(document.getElementById('pg-data').value);
    const confirmadoPor = document.getElementById('pg-confirmado-por').value.trim();

    const { error } = await supabaseClient.from('formularios_pagamento').insert({
        pessoa_id: it.pessoa_id ?? null,
        pessoa_nome: it.nome,
        local_prestacao: it.local_prestacao || null,
        data_prevista: it.data_prevista,
        valor: Number(it.valor),
        parcela: it.parcela ?? null,
        total_parcelas: it.total_parcelas ?? null,
        data_pagamento: dataISO,
        confirmado_por: confirmadoPor,
        status: 'pendente'
    });
    if (error) throw new Error('Falha ao registrar o pagamento: ' + error.message);
}

function travarLinha(token) {
    const tr = document.getElementById(linhaId(token));
    if (!tr) return;
    const btn = tr.querySelector('.pg-btn-linha');
    btn.textContent = '✓ Registrado';
    btn.classList.remove('btn-primary');
    btn.classList.add('btn-secondary');
    btn.disabled = true;
    tr.classList.add('pg-linha-enviada');
}

async function registrarLinha(token) {
    if (enviados[token]) return;
    limparMensagem();

    const erro = validarCabecalho();
    if (erro) { mostrarMensagem(erro, 'erro'); return; }

    const tr = document.getElementById(linhaId(token));
    const btn = tr.querySelector('.pg-btn-linha');
    btn.disabled = true;
    btn.textContent = 'Registrando…';

    try {
        await persistirLinha(token);
        enviados[token] = true;
        travarLinha(token);
        mostrarMensagem(`${itemPorToken(token).nome}: pagamento registrado.`, 'sucesso');
        conferirSeTerminou();
    } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Registrar pagamento';
        mostrarMensagem(e.message || 'Não foi possível registrar. Verifique a conexão e tente de novo.', 'erro');
    }
}

async function registrarTodos() {
    limparMensagem();
    document.getElementById('pg-filtro-localidade').value = '';
    aplicarFiltroLocalidade();

    const erro = validarCabecalho();
    if (erro) { mostrarMensagem(erro, 'erro'); return; }

    const pendentes = itens.map(it => it.token).filter(t => !enviados[t]);
    if (pendentes.length === 0) { mostrarMensagem('Todos os pagamentos já foram registrados.', 'info'); return; }

    const btnTodos = document.getElementById('pg-btn-todos');
    btnTodos.disabled = true;
    btnTodos.textContent = 'Registrando…';
    document.getElementById('pg-data').disabled = true;
    document.getElementById('pg-confirmado-por').disabled = true;

    try {
        for (const token of pendentes) {
            const tr = document.getElementById(linhaId(token));
            if (tr) tr.querySelector('.pg-btn-linha').textContent = 'Registrando…';
            await persistirLinha(token);
            enviados[token] = true;
            travarLinha(token);
        }
        conferirSeTerminou();
        if (document.getElementById('fp-tela-sucesso').style.display !== 'block') {
            mostrarMensagem('Pagamentos registrados.', 'sucesso');
        }
        btnTodos.textContent = 'Registrar todos os pagamentos';
    } catch (e) {
        pendentes.forEach(token => {
            if (!enviados[token]) {
                const tr = document.getElementById(linhaId(token));
                if (tr) tr.querySelector('.pg-btn-linha').textContent = 'Registrar pagamento';
            }
        });
        document.getElementById('pg-data').disabled = false;
        document.getElementById('pg-confirmado-por').disabled = false;
        btnTodos.disabled = false;
        btnTodos.textContent = 'Registrar todos os pagamentos';
        mostrarMensagem((e.message || 'Não foi possível concluir.') + ' Os que faltam continuam liberados.', 'erro');
    }
}

function conferirSeTerminou() {
    const todos = itens.length > 0 && itens.every(it => enviados[it.token]);
    if (!todos) return;
    document.getElementById('fp-tela-formulario').style.display = 'none';
    document.getElementById('fp-tela-sucesso').style.display = 'block';
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function pararComErro(texto) {
    const el = document.getElementById('pg-carregando');
    el.style.display = 'block';
    el.className = 'fp-msg erro';
    el.textContent = texto;
    document.getElementById('pg-tabelas').innerHTML = '';
    document.getElementById('pg-btn-todos').disabled = true;
    document.getElementById('pg-filtro-localidade').disabled = true;
}

async function carregarListaPorSlug(slug) {
    const { data, error } = await supabaseClient
        .from('listas_pagamento')
        .select('nome, localidades')
        .eq('slug', slug)
        .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    return { nome: data.nome, localidades: Array.isArray(data.localidades) ? data.localidades : [] };
}

function mostrarNomeDaLista(nome) {
    const alvo = document.getElementById('pg-lista-nome');
    alvo.textContent = `Equipe: ${nome}`;
    alvo.style.display = 'inline-block';
}

// ---------- init ----------
async function carregar() {
    document.getElementById('pg-data').value = hojeBR();
    document.getElementById('pg-data').addEventListener('input', function () { this.value = mascararData(this.value); });
    document.getElementById('pg-filtro-localidade').addEventListener('change', aplicarFiltroLocalidade);
    document.getElementById('pg-btn-todos').addEventListener('click', registrarTodos);

    const slugLista = (new URLSearchParams(location.search).get('lista') || '').trim();
    if (!slugLista) {
        pararComErro('Link incompleto. Use o link que você recebeu da administração da campanha (ele termina com "?lista=…").');
        return;
    }
    try {
        listaAtiva = await carregarListaPorSlug(slugLista);
    } catch (e) {
        pararComErro('Não foi possível carregar a lista desta equipe. Recarregue a página ou confirme o link com a administração da campanha.');
        return;
    }
    if (!listaAtiva) {
        pararComErro('Lista não encontrada. Confirme o link recebido com a administração da campanha.');
        return;
    }
    mostrarNomeDaLista(listaAtiva.nome);

    try {
        const resp = await fetch('pagamentos-snapshot.json', { cache: 'no-store' });
        if (!resp.ok) throw new Error(`status ${resp.status}`);
        const snap = await resp.json();
        itens = Array.isArray(snap.itens) ? snap.itens : [];
    } catch (e) {
        pararComErro('Não foi possível carregar a lista de pagamentos. Recarregue a página ou fale com a administração da campanha.');
        return;
    }

    itens = filtrarItensPorLocalidades(itens, listaAtiva.localidades);
    if (itens.length === 0) {
        pararComErro('Nenhum pagamento pendente nas localidades desta lista. Fale com a administração da campanha.');
        return;
    }

    document.getElementById('pg-carregando').style.display = 'none';
    preencherFiltroLocalidades();
    renderTabelas();
}

document.addEventListener('DOMContentLoaded', carregar);
