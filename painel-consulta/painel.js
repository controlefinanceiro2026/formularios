// Painel de Consulta — 4 telas somente-leitura (Formulários, Cadastro
// Rápido, Cadastro de Pessoal, Cadastro de Veículos). Sem servidor
// próprio: lê direto do Supabase com a sessão do usuário logado — o RLS
// (ver supabase/migracao-perfis-acesso-leitura.sql) decide o que cada
// conta enxerga. Máscaras/formatação reimplementadas aqui (não carrega
// lib/ nem app.js), mesmo padrão de formulario-publico/*.js — mantenha
// em sincronia se essas funções mudarem lá.
const supabaseClient = window.supabase.createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey);

function mascararCPF(valor) {
    return String(valor || '')
        .replace(/\D/g, '')
        .slice(0, 11)
        .replace(/(\d{3})(\d)/, '$1.$2')
        .replace(/(\d{3})(\d)/, '$1.$2')
        .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
}

function formatarData(iso) {
    if (!iso) return '—';
    const data = new Date(iso);
    if (isNaN(data.getTime())) return '—';
    if (String(iso).length <= 10) data.setMinutes(data.getMinutes() + data.getTimezoneOffset());
    return data.toLocaleDateString('pt-BR');
}

function formatarMoeda(valor) {
    if (valor == null) return '—';
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(valor);
}

function escaparHtml(valor) {
    const div = document.createElement('div');
    div.textContent = valor == null ? '' : String(valor);
    return div.innerHTML;
}

// ─── FILTRO POR COLUNA (mesmo mecanismo da plataforma principal —
// app.js#inicializarFiltroColunas — portado aqui porque este site não
// carrega app.js). Cada botão "▾" no cabeçalho abre um painel flutuante
// com busca + lista de valores únicos daquela coluna, lidos direto do
// texto das células já renderizadas. Chamar inicializarFiltroColunas()
// uma vez (é idempotente) e aplicarFiltrosColuna() a cada re-render.
const filtrosColunaEstado = {};

function estadoFiltroTabela(tableId) {
    if (!filtrosColunaEstado[tableId]) filtrosColunaEstado[tableId] = {};
    return filtrosColunaEstado[tableId];
}

function inicializarFiltroColunas(tableId, colunasExcluidas = []) {
    const thead = document.querySelector(`#${tableId} thead tr`);
    if (!thead || thead.dataset.filtroInicializado) return;
    thead.dataset.filtroInicializado = '1';
    Array.from(thead.children).forEach((th, i) => {
        if (colunasExcluidas.includes(i)) return;
        const textoOriginal = th.textContent.trim();
        th.innerHTML = `<span class="th-filtro-wrap"><span>${escaparHtml(textoOriginal)}</span>` +
            `<button type="button" class="btn-filtro-coluna" data-col="${i}" onclick="abrirPainelFiltroColuna(event, '${tableId}', ${i})" title="Filtrar">▾</button></span>`;
    });
}

function linhasDeDadosTabela(tableId) {
    return Array.from(document.querySelectorAll(`#${tableId} tbody tr`)).filter(tr => tr.children.length > 1);
}

function valoresUnicosColuna(tableId, colIndex) {
    const valores = new Set();
    linhasDeDadosTabela(tableId).forEach(tr => {
        const td = tr.children[colIndex];
        valores.add(td ? (td.textContent.trim() || '(vazio)') : '(vazio)');
    });
    return Array.from(valores).sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

let painelFiltroColunaAberto = null;

function fecharPainelFiltroColunaFora(e) {
    if (painelFiltroColunaAberto && !painelFiltroColunaAberto.contains(e.target) && !e.target.closest('.btn-filtro-coluna')) {
        fecharPainelFiltroColuna();
    }
}

function fecharPainelFiltroColuna() {
    if (painelFiltroColunaAberto) { painelFiltroColunaAberto.remove(); painelFiltroColunaAberto = null; }
    document.removeEventListener('click', fecharPainelFiltroColunaFora, true);
}

function abrirPainelFiltroColuna(evento, tableId, colIndex) {
    evento.stopPropagation();
    const reabrindoMesmaColuna = painelFiltroColunaAberto
        && painelFiltroColunaAberto.dataset.tabela === tableId
        && painelFiltroColunaAberto.dataset.col === String(colIndex);
    fecharPainelFiltroColuna();
    if (reabrindoMesmaColuna) return;

    const estado = estadoFiltroTabela(tableId);
    const selecionados = estado[colIndex];
    const valores = valoresUnicosColuna(tableId, colIndex);

    const ordenacaoAtual = ordenacaoColunaEstado[tableId];
    const ordenandoEstaColuna = ordenacaoAtual && ordenacaoAtual.colIndex === colIndex;

    const painel = document.createElement('div');
    painel.className = 'painel-filtro-coluna';
    painel.dataset.tabela = tableId;
    painel.dataset.col = colIndex;
    painel.innerHTML = `
        <div class="ordenar-coluna">
            <button type="button" class="${ordenandoEstaColuna && ordenacaoAtual.direcao === 'asc' ? 'ativo' : ''}" onclick="ordenarPorColuna('${tableId}', ${colIndex}, 'asc')">🔼 Classificar A → Z</button>
            <button type="button" class="${ordenandoEstaColuna && ordenacaoAtual.direcao === 'desc' ? 'ativo' : ''}" onclick="ordenarPorColuna('${tableId}', ${colIndex}, 'desc')">🔽 Classificar Z → A</button>
        </div>
        <input type="text" placeholder="Buscar..." oninput="filtrarListaValoresPainel(this)">
        <label class="label-todos"><input type="checkbox" class="chk-selecionar-todos-filtro" ${!selecionados ? 'checked' : ''} onchange="alternarTodosFiltroColuna(this)"> Selecionar tudo</label>
        <div class="lista-valores">
            ${valores.map(v => `<label><input type="checkbox" value="${escaparHtml(v)}" ${(!selecionados || selecionados.has(v)) ? 'checked' : ''}> ${escaparHtml(v)}</label>`).join('')}
        </div>
        <div class="acoes">
            <button type="button" class="btn-secondary" onclick="limparFiltroColuna('${tableId}', ${colIndex})">Limpar</button>
            <button type="button" class="btn-primary" onclick="confirmarFiltroColuna('${tableId}', ${colIndex})">OK</button>
        </div>`;

    document.body.appendChild(painel);
    const rect = evento.currentTarget.getBoundingClientRect();
    const larguraPainel = 230;
    painel.style.top = `${rect.bottom + window.scrollY + 4}px`;
    painel.style.left = `${Math.min(rect.left + window.scrollX, window.scrollX + window.innerWidth - larguraPainel - 10)}px`;
    painelFiltroColunaAberto = painel;
    setTimeout(() => document.addEventListener('click', fecharPainelFiltroColunaFora, true), 0);
}

function filtrarListaValoresPainel(input) {
    const termo = input.value.toLowerCase();
    input.closest('.painel-filtro-coluna').querySelectorAll('.lista-valores label').forEach(label => {
        label.style.display = label.textContent.toLowerCase().includes(termo) ? 'flex' : 'none';
    });
}

function alternarTodosFiltroColuna(chkTodos) {
    chkTodos.closest('.painel-filtro-coluna').querySelectorAll('.lista-valores input[type="checkbox"]').forEach(c => {
        c.checked = chkTodos.checked;
    });
}

function limparFiltroColuna(tableId, colIndex) {
    delete estadoFiltroTabela(tableId)[colIndex];
    fecharPainelFiltroColuna();
    aplicarFiltrosColuna(tableId);
}

function confirmarFiltroColuna(tableId, colIndex) {
    const painel = painelFiltroColunaAberto;
    if (!painel) return;
    const marcados = Array.from(painel.querySelectorAll('.lista-valores input[type="checkbox"]:checked')).map(c => c.value);
    const todosValores = valoresUnicosColuna(tableId, colIndex);
    const estado = estadoFiltroTabela(tableId);

    if (marcados.length === todosValores.length) {
        delete estado[colIndex];
    } else {
        estado[colIndex] = new Set(marcados);
    }
    fecharPainelFiltroColuna();
    aplicarFiltrosColuna(tableId);
}

const ordenacaoColunaEstado = {};

function limparParaNumero(valor) {
    const limpo = String(valor).replace(/[^\d,.-]/g, '');
    if (!limpo) return NaN;
    const comPontoDecimal = limpo.includes(',') ? limpo.replace(/\./g, '').replace(',', '.') : limpo;
    return parseFloat(comPontoDecimal);
}

function ordenarPorColuna(tableId, colIndex, direcao) {
    ordenacaoColunaEstado[tableId] = { colIndex, direcao };
    fecharPainelFiltroColuna();
    aplicarOrdenacaoColuna(tableId);
    atualizarIndicadoresFiltroColuna(tableId);
}

function aplicarOrdenacaoColuna(tableId) {
    const estado = ordenacaoColunaEstado[tableId];
    if (!estado) return;
    const tbody = document.querySelector(`#${tableId} tbody`);
    const linhas = linhasDeDadosTabela(tableId);
    if (!tbody || linhas.length < 2) return;

    const linhasComValor = linhas.map(tr => {
        const td = tr.children[estado.colIndex];
        return { tr, valor: td ? td.textContent.trim() : '' };
    });

    const comValor = linhasComValor.filter(l => l.valor);
    const numericos = comValor.filter(l => !isNaN(limparParaNumero(l.valor)));
    const ehNumerica = comValor.length > 0 && numericos.length >= Math.ceil(comValor.length * 0.8);

    const comparar = ehNumerica
        ? (a, b) => {
            const na = limparParaNumero(a); const nb = limparParaNumero(b);
            return (isNaN(na) ? -Infinity : na) - (isNaN(nb) ? -Infinity : nb);
        }
        : (a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' });

    linhasComValor.sort((a, b) => estado.direcao === 'asc' ? comparar(a.valor, b.valor) : comparar(b.valor, a.valor));
    linhasComValor.forEach(({ tr }) => tbody.appendChild(tr));
}

function aplicarFiltrosColuna(tableId) {
    const estado = estadoFiltroTabela(tableId);
    const colunasFiltradas = Object.keys(estado);

    linhasDeDadosTabela(tableId).forEach(tr => {
        const visivel = colunasFiltradas.every(colIndex => {
            const td = tr.children[colIndex];
            const valor = td ? (td.textContent.trim() || '(vazio)') : '(vazio)';
            return estado[colIndex].has(valor);
        });
        tr.style.display = visivel ? '' : 'none';
    });

    aplicarOrdenacaoColuna(tableId);
    atualizarIndicadoresFiltroColuna(tableId);
}

function atualizarIndicadoresFiltroColuna(tableId) {
    const estado = estadoFiltroTabela(tableId);
    const ordenacao = ordenacaoColunaEstado[tableId];

    document.querySelectorAll(`#${tableId} thead .btn-filtro-coluna`).forEach(btn => {
        const col = btn.dataset.col;
        const filtrada = Object.prototype.hasOwnProperty.call(estado, col);
        const ordenandoEstaColuna = ordenacao && String(ordenacao.colIndex) === col;
        btn.classList.toggle('ativo', filtrada || !!ordenandoEstaColuna);
        btn.textContent = ordenandoEstaColuna ? (ordenacao.direcao === 'asc' ? '▲' : '▼') : '▾';
    });
}

// A pessoal/veiculos os campos de documento guardam a URL "pública"
// inteira (mesmo em bucket privado — RLS decide, não a URL); pra baixar
// via supabaseClient.storage é preciso só o caminho dentro do bucket.
function caminhoDoBucket(url, bucket) {
    if (!url) return null;
    const partes = url.split(`/${bucket}/`);
    return partes.length > 1 ? decodeURIComponent(partes[1]) : url;
}

// ─── NAVEGAÇÃO DA SIDEBAR (mesmo padrão da plataforma principal) ───────
function configurarNavegacao() {
    const links = document.querySelectorAll('.nav-link');
    const title = document.getElementById('page-title');

    links.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const pageId = link.getAttribute('data-page');

            links.forEach(l => l.classList.remove('active'));
            link.classList.add('active');

            document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
            document.getElementById(pageId).classList.add('active');

            title.textContent = link.textContent.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|\p{Emoji_Presentation}/gu, '').trim();
        });
    });
}

// ─── SESSÃO ─────────────────────────────────────────────────────────────
async function exigirSessao() {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) { window.location.href = 'index.html'; return null; }
    return session;
}

async function sair() {
    await supabaseClient.auth.signOut();
    window.location.href = 'index.html';
}

// papel: 'admin' | 'leitor' | 'validador' — só validador (e admin) vê o
// botão "Validar" em Formulários. Lido da própria linha em perfis_acesso
// (RLS: cada conta só enxerga a si mesma).
let meuPapel = null;

async function carregarPapel() {
    const { data } = await supabaseClient.from('perfis_acesso').select('papel').maybeSingle();
    meuPapel = data ? data.papel : null;
}

function possoValidarFormularios() {
    return meuPapel === 'validador' || meuPapel === 'admin';
}

function linhaVazia(colspan, texto) {
    return `<tr><td colspan="${colspan}" class="text-center text-muted" style="padding:2rem;">${texto}</td></tr>`;
}

// ─── VISUALIZADOR DE DOCUMENTO ──────────────────────────────────────────
// Buckets privados (RLS "to authenticated") — .download() usa a sessão
// logada pra autenticar de verdade; um <img>/<iframe src="URL pública">
// direto NÃO funciona nesses buckets (testado: Supabase devolve
// "Bucket not found" pra qualquer requisição sem essa autenticação).
async function visualizarDocumento(bucket, caminho, titulo) {
    if (!caminho) return;
    document.getElementById('modal-documento-titulo').textContent = `📎 ${titulo}`;
    const body = document.getElementById('modal-documento-body');
    body.innerHTML = '<p style="color:#64748b;">Carregando…</p>';
    document.getElementById('modal-documento').classList.add('show');

    const { data, error } = await supabaseClient.storage.from(bucket).download(caminho);
    if (error || !data) {
        body.innerHTML = `<p style="color:#b91c1c; padding:1rem;">Não foi possível carregar o documento: ${escaparHtml(error ? error.message : 'arquivo não encontrado')}</p>`;
        return;
    }
    const blobUrl = URL.createObjectURL(data);
    const ext = caminho.split('.').pop().toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
        body.innerHTML = `<img src="${blobUrl}" style="max-width:100%; max-height:70vh; object-fit:contain;">`;
    } else {
        body.innerHTML = `<iframe src="${blobUrl}" style="width:100%; height:70vh; border:none;"></iframe>`;
    }
}

function fecharModalDocumento() {
    document.getElementById('modal-documento').classList.remove('show');
    document.getElementById('modal-documento-body').innerHTML = '';
}

// ─── GERAÇÃO DE CONTRATO / TERMO DE CESSÃO ──────────────────────────────
// Ver pdfDocumentos.js — mesmo texto de lib/pdfContrato.js /
// lib/pdfTermoCessao.js (servidor), portado pra jsPDF porque este site é
// estático (sem servidor próprio).
function gerarContratoPessoal(pessoa) {
    abrirPdfEmNovaAba(gerarPdfContrato(pessoa));
}

function gerarTermoCessaoVeiculo(veiculo) {
    abrirPdfEmNovaAba(gerarPdfTermoCessao(veiculo));
}

// ─── FORMULÁRIOS ────────────────────────────────────────────────────────
let cachePessoal = [];
let cacheVeiculos = [];
let cacheFormulariosPessoal = [];
let cacheFormulariosVeiculo = [];

// Aprovação simplificada de um pré-cadastro — usa os mesmos padrões já
// aplicados na validação da plataforma principal (vigência do contrato,
// valor por função). Ajustes finos (trocar líder, localidade, valor,
// levar os documentos anexados para o cadastro definitivo) não fazem
// parte deste fluxo.
const VALOR_CONTRATO_PADRAO_PESSOAL = { lider: 2000, multiplicador: 1600 };
const VALOR_ALUGUEL_VEICULO_PADRAO = 2000;
const CNPJ_ASSOCIADO_PADRAO_VEICULO = '99.999.999/9999-99';

function normalizarNomeComparacao(valor) {
    return String(valor == null ? '' : valor)
        .normalize('NFD').replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function liderPorNome(nome) {
    const chave = normalizarNomeComparacao(nome);
    if (!chave) return null;
    return cachePessoal.find(p => p.funcao === 'lider' && normalizarNomeComparacao(p.nome) === chave) || null;
}

async function validarFormularioPessoal(id, botao) {
    const f = cacheFormulariosPessoal.find(x => x.id === id);
    if (!f) return;
    if (!confirm(`Validar o cadastro de "${f.nome}"? Cria a pessoa no Cadastro de Pessoal com vigência de 15/08/2026 a 04/10/2026.`)) return;
    botao.disabled = true;

    const payload = {
        nome: f.nome,
        cpf: f.cpf,
        endereco: f.endereco,
        telefone: f.telefone,
        cep: f.cep,
        funcao: f.funcao,
        local_prestacao: f.local_prestacao,
        descricao_atividades: f.funcao === 'lider' ? 'Liderança' : 'Multiplicação',
        data_inicio: '2026-08-15',
        data_fim: '2026-10-04',
        valor_contrato: VALOR_CONTRATO_PADRAO_PESSOAL[f.funcao] ?? VALOR_CONTRATO_PADRAO_PESSOAL.multiplicador,
        contabilizar_campanha: 0
    };
    const { data: nova, error: erroInsert } = await supabaseClient.from('pessoal_contratado').insert(payload).select().single();
    if (erroInsert) { alert('Não foi possível validar: ' + erroInsert.message); botao.disabled = false; return; }

    const { error: erroUpdate } = await supabaseClient.from('formularios_pessoal')
        .update({ status: 'validado', pessoa_id: nova.id }).eq('id', f.id);
    if (erroUpdate) alert('O cadastro foi criado, mas não foi possível marcar o formulário como validado: ' + erroUpdate.message);

    await Promise.all([carregarFormularios(), carregarPessoal()]);
}

async function validarFormularioVeiculo(id, botao) {
    const f = cacheFormulariosVeiculo.find(x => x.id === id);
    if (!f) return;
    const lider = liderPorNome(f.nome_proprietario);
    const aviso = lider ? ` Será associado ao líder ${lider.nome}.` : ' Nenhum líder cadastrado com esse nome — o veículo fica sem líder associado.';
    if (!confirm(`Validar o veículo placa "${f.placa}"?${aviso}`)) return;
    botao.disabled = true;

    const hoje = new Date();
    const dataHojeIso = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;

    const payload = {
        placa: f.placa,
        marca: f.marca || null,
        modelo: f.modelo || null,
        ano_fabricacao: f.ano_fabricacao || null,
        cnpj_associado: f.cnpj_associado || CNPJ_ASSOCIADO_PADRAO_VEICULO,
        nome_proprietario: lider ? lider.nome : (f.nome_proprietario || null),
        cpf_proprietario: lider ? mascararCPF(lider.cpf) : (f.cpf_proprietario || null),
        localidade_atendimento: lider ? lider.local_prestacao : null,
        lider_id: lider ? lider.id : null,
        valor_contratado: f.valor_contratado || VALOR_ALUGUEL_VEICULO_PADRAO,
        data_inicio_cessao: dataHojeIso
    };
    const { data: novo, error: erroInsert } = await supabaseClient.from('veiculos').insert(payload).select().single();
    if (erroInsert) { alert('Não foi possível validar: ' + erroInsert.message); botao.disabled = false; return; }

    const { error: erroUpdate } = await supabaseClient.from('formularios_veiculo')
        .update({ status: 'validado', veiculo_id: novo.id }).eq('id', f.id);
    if (erroUpdate) alert('O cadastro foi criado, mas não foi possível marcar o formulário como validado: ' + erroUpdate.message);

    await Promise.all([carregarFormularios(), carregarVeiculos()]);
}

async function carregarFormularios() {
    const tbody = document.getElementById('formularios-body');
    inicializarFiltroColunas('tabela-formularios', [8, 9]);
    const [{ data: pessoal, error: eP }, { data: veiculo, error: eV }] = await Promise.all([
        supabaseClient.from('formularios_pessoal').select('*'),
        supabaseClient.from('formularios_veiculo').select('*')
    ]);
    if (eP || eV) { tbody.innerHTML = linhaVazia(10, 'Erro ao carregar formulários.'); return; }
    cacheFormulariosPessoal = pessoal || [];
    cacheFormulariosVeiculo = veiculo || [];

    const podeValidar = possoValidarFormularios();

    const linhasPessoal = cacheFormulariosPessoal.map(f => `
        <tr>
            <td>Pessoal</td>
            <td>${escaparHtml(f.nome)}</td>
            <td>${escaparHtml(mascararCPF(f.cpf))}</td>
            <td>—</td>
            <td>${escaparHtml(f.funcao || '—')}</td>
            <td>${escaparHtml(f.local_prestacao || '—')}</td>
            <td>${escaparHtml(f.status)}</td>
            <td>${formatarData(f.created_at)}</td>
            <td>
                ${f.documento_cpf_path ? `<button class="btn-icon" onclick="visualizarDocumento('documentos-formularios','${f.documento_cpf_path}','CPF — ${escaparHtml(f.nome)}')" title="Ver documento de CPF">🪪</button>` : ''}
                ${f.comprovante_residencia_path ? `<button class="btn-icon" onclick="visualizarDocumento('documentos-formularios','${f.comprovante_residencia_path}','Comprovante de Residência — ${escaparHtml(f.nome)}')" title="Ver comprovante de residência">🏠</button>` : ''}
                ${!f.documento_cpf_path && !f.comprovante_residencia_path ? '<span style="color:#cbd5e1;">—</span>' : ''}
            </td>
            <td>${podeValidar && f.status === 'pendente' ? `<button class="btn-icon" onclick="validarFormularioPessoal(${f.id}, this)" title="Validar">✅</button>` : '—'}</td>
        </tr>`);

    const linhasVeiculo = cacheFormulariosVeiculo.map(f => `
        <tr>
            <td>Veículo</td>
            <td>${escaparHtml(f.nome_proprietario || '—')}</td>
            <td>${escaparHtml(f.placa)}</td>
            <td>${escaparHtml(`${f.marca || ''} ${f.modelo || ''}`.trim() || '—')}</td>
            <td>—</td>
            <td>${escaparHtml(f.cnpj_associado || '—')}</td>
            <td>${escaparHtml(f.status)}</td>
            <td>${formatarData(f.created_at)}</td>
            <td>
                ${f.documento_veiculo_path ? `<button class="btn-icon" onclick="visualizarDocumento('documentos-formularios','${f.documento_veiculo_path}','CRLV — ${escaparHtml(f.placa)}')" title="Ver CRLV">📎</button>` : '<span style="color:#cbd5e1;">—</span>'}
            </td>
            <td>${podeValidar && f.status === 'pendente' ? `<button class="btn-icon" onclick="validarFormularioVeiculo(${f.id}, this)" title="Validar">✅</button>` : '—'}</td>
        </tr>`);

    const linhas = [...linhasPessoal, ...linhasVeiculo];
    tbody.innerHTML = linhas.length ? linhas.join('') : linhaVazia(10, 'Nenhum formulário recebido.');
    aplicarFiltrosColuna('tabela-formularios');
}

// ─── CADASTRO RÁPIDO ────────────────────────────────────────────────────
async function carregarCadastroRapido() {
    const tbody = document.getElementById('cadastro-rapido-body');
    inicializarFiltroColunas('tabela-cadastro-rapido');
    const { data, error } = await supabaseClient.from('formularios_cadastro_rapido').select('*').order('created_at', { ascending: false });
    if (error) { tbody.innerHTML = linhaVazia(8, 'Erro ao carregar cadastros.'); return; }
    if (!data || !data.length) { tbody.innerHTML = linhaVazia(8, 'Nenhum cadastro recebido.'); aplicarFiltrosColuna('tabela-cadastro-rapido'); return; }

    tbody.innerHTML = data.map(f => `
        <tr>
            <td>${formatarData(f.created_at)}</td>
            <td>${escaparHtml(f.nome)}</td>
            <td>${escaparHtml(mascararCPF(f.cpf))}</td>
            <td>${escaparHtml(f.telefone)}</td>
            <td>${escaparHtml(f.local_prestacao)}</td>
            <td>${escaparHtml(f.placa)}</td>
            <td>${escaparHtml(f.modelo)}</td>
            <td>${escaparHtml(f.status)}</td>
        </tr>`).join('');

    aplicarFiltrosColuna('tabela-cadastro-rapido');
}

// ─── CADASTRO DE PESSOAL ────────────────────────────────────────────────
async function carregarPessoal() {
    const tbody = document.getElementById('pessoal-body');
    inicializarFiltroColunas('tabela-pessoal', [9, 10]);
    const { data, error } = await supabaseClient.rpc('leitor_listar_pessoal');
    if (error) { tbody.innerHTML = linhaVazia(11, 'Erro ao carregar Pessoal.'); return; }
    cachePessoal = data || [];
    if (!cachePessoal.length) { tbody.innerHTML = linhaVazia(11, 'Nenhuma pessoa cadastrada.'); aplicarFiltrosColuna('tabela-pessoal'); return; }

    tbody.innerHTML = cachePessoal.map(p => {
        const caminhoContrato = caminhoDoBucket(p.contrato_url, 'documentos-pessoal');
        const caminhoComprovanteResidencia = caminhoDoBucket(p.comprovante_residencia_url, 'documentos-pessoal');
        const caminhoComprovanteCpf = caminhoDoBucket(p.comprovante_cpf_url, 'documentos-pessoal');
        return `
        <tr>
            <td>${escaparHtml(p.nome)}</td>
            <td>${escaparHtml(mascararCPF(p.cpf))}</td>
            <td>${escaparHtml(p.telefone)}</td>
            <td>${escaparHtml(p.descricao_atividades)}</td>
            <td>${escaparHtml(p.local_prestacao)}</td>
            <td>${escaparHtml(p.jornada_trabalho)}</td>
            <td>${p.data_inicio ? formatarData(p.data_inicio) : '—'}</td>
            <td>${p.data_fim ? formatarData(p.data_fim) : '—'}</td>
            <td>${p.valor_contrato ? formatarMoeda(p.valor_contrato) : '—'}</td>
            <td>
                ${caminhoContrato ? `<button class="btn-icon" onclick="visualizarDocumento('documentos-pessoal','${caminhoContrato}','Contrato anexado — ${escaparHtml(p.nome)}')" title="Ver contrato anexado">📎</button>` : ''}
                ${caminhoComprovanteCpf ? `<button class="btn-icon" onclick="visualizarDocumento('documentos-pessoal','${caminhoComprovanteCpf}','CPF — ${escaparHtml(p.nome)}')" title="Ver documento de CPF">🪪</button>` : ''}
                ${caminhoComprovanteResidencia ? `<button class="btn-icon" onclick="visualizarDocumento('documentos-pessoal','${caminhoComprovanteResidencia}','Comprovante de Residência — ${escaparHtml(p.nome)}')" title="Ver comprovante de residência">🏠</button>` : ''}
                ${!caminhoContrato && !caminhoComprovanteCpf && !caminhoComprovanteResidencia ? '<span style="color:#cbd5e1;">—</span>' : ''}
            </td>
            <td><button class="btn-icon" onclick="gerarContratoPessoal(cachePessoal.find(x => x.id === ${p.id}))" title="Gerar Contrato de Prestação de Serviços">📄</button></td>
        </tr>`;
    }).join('');

    aplicarFiltrosColuna('tabela-pessoal');
}

// ─── CADASTRO DE VEÍCULOS ───────────────────────────────────────────────
async function carregarVeiculos() {
    const tbody = document.getElementById('veiculos-body');
    inicializarFiltroColunas('tabela-veiculos', [6, 7]);
    const { data, error } = await supabaseClient.from('veiculos').select('*').order('placa');
    if (error) { tbody.innerHTML = linhaVazia(8, 'Erro ao carregar Veículos.'); return; }
    cacheVeiculos = data || [];
    if (!cacheVeiculos.length) { tbody.innerHTML = linhaVazia(8, 'Nenhum veículo cadastrado.'); aplicarFiltrosColuna('tabela-veiculos'); return; }

    tbody.innerHTML = cacheVeiculos.map(v => {
        const caminhoDocumento = caminhoDoBucket(v.documento_url, 'documentos-veiculo');
        return `
        <tr>
            <td>${escaparHtml(v.placa)}</td>
            <td>${escaparHtml(`${v.marca || ''} ${v.modelo || ''}`.trim() || '—')}</td>
            <td>${escaparHtml(v.nome_proprietario)}</td>
            <td>${escaparHtml(v.cnpj_associado)}</td>
            <td>${escaparHtml(v.localidade_atendimento)}</td>
            <td>${v.valor_contratado != null ? formatarMoeda(v.valor_contratado) : '—'}</td>
            <td>${caminhoDocumento ? `<button class="btn-icon" onclick="visualizarDocumento('documentos-veiculo','${caminhoDocumento}','CRLV — ${escaparHtml(v.placa)}')" title="Ver documento do veículo">📎</button>` : '<span style="color:#cbd5e1;">—</span>'}</td>
            <td><button class="btn-icon" onclick="gerarTermoCessaoVeiculo(cacheVeiculos.find(x => x.id === ${v.id}))" title="Gerar Termo de Cessão">📄</button></td>
        </tr>`;
    }).join('');

    aplicarFiltrosColuna('tabela-veiculos');
}

document.addEventListener('DOMContentLoaded', async () => {
    const sessao = await exigirSessao();
    if (!sessao) return;
    document.getElementById('user-email').textContent = sessao.user.email;
    configurarNavegacao();
    await carregarPapel();
    // Pessoal carrega antes de Formulários: validar um veículo precisa da
    // lista de líderes já em cachePessoal pra casar o proprietário.
    await carregarPessoal();
    await Promise.all([carregarFormularios(), carregarCadastroRapido(), carregarVeiculos()]);
});
