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

function apenasDigitos(valor) {
    return String(valor == null ? '' : valor).replace(/\D/g, '');
}

// Placa sem separadores, maiúsculas, no máximo 7 caracteres — cobre os dois
// padrões (cinza AAA9999 e Mercosul AAA9A99). Mesma normalização usada pra
// comparar placas e pra "mascarar" o campo de busca.
function normalizarPlaca(valor) {
    return String(valor == null ? '' : valor).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 7);
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

// Nome e endereço vão para pessoal_contratado / veiculos em CAIXA ALTA —
// mesmo padrão do app.js (nomePessoaCaixaAlta / enderecoCaixaAlta) e do
// gatilho no Supabase (ver supabase/migracao-nome-endereco-caixa-alta.sql).
function nomeCaixaAlta(valor) {
    return String(valor || '').trim().replace(/\s+/g, ' ').toUpperCase();
}
function enderecoCaixaAlta(valor) {
    return String(valor || '').trim().replace(/\s+/g, ' ').toUpperCase() || null;
}

// ─── PAGINAÇÃO ─────────────────────────────────────────────────────────
// O PostgREST corta cada resposta em ~1000 linhas (db-max-rows). A
// plataforma principal contorna isso em lib/queryEngine.js (toda leitura
// passa por lá); este site fala DIRETO com o Supabase, sem esse
// intermediário, então cada tela que pode passar de 1000 linhas
// (Pessoal, Veículos, Formulários, Cadastro Rápido, Multiplicadores)
// precisa paginar aqui — senão some com o resto da lista.
//
// `construirQuery(de, ate)` deve devolver uma query NOVA a cada chamada,
// já com .range(de, ate) e uma ORDENAÇÃO DETERMINÍSTICA (ex: .order('id'));
// sem isso o range() repete/pula linhas na virada de página. Retorna
// { data, error } no mesmo formato de uma query única.
const TAMANHO_PAGINA_SUPABASE = 1000;

async function lerTodasAsPaginas(construirQuery) {
    const todas = [];
    for (let inicio = 0; ; inicio += TAMANHO_PAGINA_SUPABASE) {
        const { data, error } = await construirQuery(inicio, inicio + TAMANHO_PAGINA_SUPABASE - 1);
        if (error) return { data: null, error };
        if (!data || data.length === 0) break;
        todas.push(...data);
        if (data.length < TAMANHO_PAGINA_SUPABASE) break;
    }
    return { data: todas, error: null };
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

// Sanitização de segmento de caminho do Storage — espelho de app.js
// (sanitizarSegmentoCaminho): tira acento/cedilha (o Storage rejeita) e
// troca "/" por "-" pra não criar nível de pasta indesejado.
function sanitizarSegmentoCaminho(valor) {
    return String(valor || '')
        .normalize('NFD').replace(/\p{Diacritic}/gu, '')
        .trim().replace(/[\/\\]+/g, '-') || 'sem-nome';
}

// Pasta individual da pessoa dentro de "documentos-pessoal" — "{NOME}_{CPF}",
// mesma convenção de app.js#pastaDocumentosPessoal, pra o admin e o validador
// caírem na mesma pasta.
function pastaDocumentosPessoal(nome, cpfDigitos) {
    return `${sanitizarSegmentoCaminho(nome)}_${cpfDigitos}`;
}

// URL gravada no registro = caminho do proxy autenticado da plataforma
// principal (mesmo formato que app.js grava, via local-client.js).
function urlProxyStorage(bucket, caminho) {
    return `/api/storage/ver/${bucket}/${encodeURIComponent(caminho)}`;
}

// "documentos-formularios" é só a caixa de entrada do formulário público —
// ao validar, o documento é baixado de lá, reenviado para o bucket
// definitivo (na convenção de um upload manual) e o original é apagado.
// Falha na migração NÃO trava a validação: retorna null e o documento
// segue acessível pelo caminho original em formularios_*.
async function migrarDocumentoFormulario(caminhoOrigem, bucketDestino, caminhoDestino) {
    try {
        const { data, error } = await supabaseClient.storage.from('documentos-formularios').download(caminhoOrigem);
        if (error || !data) throw new Error(error ? error.message : 'arquivo não encontrado');
        const { error: erroUpload } = await supabaseClient.storage.from(bucketDestino).upload(caminhoDestino, data, { upsert: true });
        if (erroUpload) throw new Error(erroUpload.message);
        const { error: erroRemove } = await supabaseClient.storage.from('documentos-formularios').remove([caminhoOrigem]);
        if (erroRemove) console.warn(`Documento migrado, mas o original não foi apagado (${caminhoOrigem}):`, erroRemove.message);
        return urlProxyStorage(bucketDestino, caminhoDestino);
    } catch (erro) {
        console.error(`Falha ao migrar documento do formulário (${caminhoOrigem}) para ${bucketDestino}/${caminhoDestino}:`, erro);
        return null;
    }
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

// Perfil 'leitor' fica restrito a Consulta Rápida e Formulários — as demais
// telas (Cadastro Rápido, Multiplicadores, Pessoal, Veículos) somem da
// navegação. 'validador' e 'admin' continuam vendo tudo.
const TELAS_PERMITIDAS_LEITOR = ['consulta-rapida', 'formularios'];

function ehLeitor() {
    return meuPapel === 'leitor';
}

function aplicarRestricoesDeNavegacao() {
    if (!ehLeitor()) return;
    document.querySelectorAll('.nav-link').forEach(link => {
        if (!TELAS_PERMITIDAS_LEITOR.includes(link.dataset.page)) {
            link.style.display = 'none';
        }
    });
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
// Se a pessoa tem o contrato ASSINADO anexado, abre esse arquivo; senão
// gera o PDF do contrato a partir dos dados.
function gerarContratoPessoal(pessoa) {
    const caminhoAssinado = caminhoDoBucket(pessoa && pessoa.contrato_url, 'documentos-pessoal');
    if (caminhoAssinado) {
        visualizarDocumento('documentos-pessoal', caminhoAssinado, `Contrato assinado — ${pessoa.nome || ''}`);
        return;
    }
    abrirPdfEmNovaAba(gerarPdfContrato(pessoa));
}

function gerarTermoCessaoVeiculo(veiculo) {
    abrirPdfEmNovaAba(gerarPdfTermoCessao(veiculo));
}

// ─── FORMULÁRIOS ────────────────────────────────────────────────────────
let cachePessoal = [];
let cacheVeiculos = [];
// Vira true quando Pessoal e Veículos terminaram de carregar — a Consulta
// Rápida usa pra avisar em vez de dizer "nada encontrado" cedo demais.
let dadosProntos = false;
let cacheFormulariosPessoal = [];
let cacheFormulariosVeiculo = [];

// Aprovação simplificada de um pré-cadastro — usa os mesmos padrões já
// aplicados na validação da plataforma principal (vigência do contrato,
// valor por função). Ajustes finos (trocar líder, localidade, valor,
// levar os documentos anexados para o cadastro definitivo) não fazem
// parte deste fluxo.
const VALOR_CONTRATO_PADRAO_PESSOAL = { lider: 2000, multiplicador: 1600 };
// Descrição das Atividades é fixa por função (mesmos textos da plataforma principal).
const ATRIBUICAO_ATIVIDADES_PESSOAL = {
    fiscalizacao: 'Fiscalização de Campanha',
    lider: 'Coordenação de Equipe',
    multiplicador: 'Militância e mobilização de rua'
};
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

let formularioPessoalParaValidar = null;

async function validarFormularioPessoal(id, botao) {
    const f = cacheFormulariosPessoal.find(x => x.id === id);
    if (!f) return;
    // Toda validação de Pessoal passa pelo modal: confirma a função (vem
    // preenchida quando o formulário já traz) e pede o Coordenador (texto
    // livre) antes de gravar.
    abrirModalFuncaoFormularioPessoal(f, botao);
}

// Modal de validação de uma pré-inscrição de Pessoal: função (+ líder se
// multiplicador) e Coordenador. `coordenadorInicial` pré-preenche o campo
// (usado pela validação em lote, que pergunta o coordenador uma vez só).
function abrirModalFuncaoFormularioPessoal(f, botao = null, coordenadorInicial = '') {
    formularioPessoalParaValidar = { f, botao };
    document.getElementById('vpf-nome').textContent = f.nome || '';
    document.getElementById('vpf-cpf').textContent = f.cpf ? ` — ${mascararCPF(f.cpf)}` : '';
    document.getElementById('vpf-funcao').value = (f.funcao === 'lider' || f.funcao === 'multiplicador') ? f.funcao : 'lider';
    document.getElementById('vpf-coordenador').value = coordenadorInicial || '';

    const lideres = cachePessoal.filter(p => p.funcao === 'lider')
        .sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR'));
    document.getElementById('vpf-lider').innerHTML = lideres.length
        ? lideres.map(l => `<option value="${l.id}">${escaparHtml(l.nome)}</option>`).join('')
        : '<option value="">Nenhum líder cadastrado</option>';

    // Pré-seleciona o líder: pelo id, ou pelo nome pretendido (f.lider_nome,
    // fluxo do formulário do administrador). Se o líder ainda não existe,
    // avisa que ele precisa ser validado antes.
    const dica = document.getElementById('vpf-lider-dica');
    dica.textContent = 'A localidade fica a mesma do líder escolhido.';
    if (f.lider_id) {
        document.getElementById('vpf-lider').value = String(f.lider_id);
    } else if (f.lider_nome) {
        const lider = liderPorNome(f.lider_nome);
        if (lider) {
            document.getElementById('vpf-lider').value = String(lider.id);
            dica.textContent = `Líder do formulário: ${lider.nome} (associado automaticamente).`;
        } else {
            dica.textContent = `Líder do formulário: "${f.lider_nome}" — ainda não cadastrado. Valide o líder antes, ou escolha um da lista.`;
        }
    }

    atualizarVisibilidadeLiderFuncaoFormulario();
    document.getElementById('modal-validar-pessoal-funcao').classList.add('show');
}

function fecharModalFuncaoFormularioPessoal() {
    document.getElementById('modal-validar-pessoal-funcao').classList.remove('show');
    formularioPessoalParaValidar = null;
}

// Botões "Cancelar" / "×" do modal — se estivermos no meio de uma validação
// em lote, aborta o restante da fila e mostra o resumo do que já rodou.
function cancelarModalFuncaoFormularioPessoal() {
    fecharModalFuncaoFormularioPessoal();
    if (!resumoLoteFormularios) return;
    resumoLoteFormularios.pulados += filaFuncaoLote.length;
    const resumo = resumoLoteFormularios;
    filaFuncaoLote = [];
    resumoLoteFormularios = null;
    carregarFormularios().then(() => mostrarResumoLoteFormularios(resumo));
}

function atualizarVisibilidadeLiderFuncaoFormulario() {
    const ehMultiplicador = document.getElementById('vpf-funcao').value === 'multiplicador';
    document.getElementById('vpf-lider-grupo').style.display = ehMultiplicador ? 'block' : 'none';
}

async function confirmarFuncaoFormularioPessoal(botaoModal) {
    if (!formularioPessoalParaValidar) return;
    const { f, botao } = formularioPessoalParaValidar;
    const funcao = document.getElementById('vpf-funcao').value;

    let liderId = null;
    let localPrestacao = f.local_prestacao;
    if (funcao === 'multiplicador') {
        liderId = Number(document.getElementById('vpf-lider').value) || null;
        if (!liderId) { alert('Escolha um líder responsável para o multiplicador.'); return; }
        const lider = cachePessoal.find(p => p.id === liderId) || null;
        if (lider) localPrestacao = lider.local_prestacao;
    }
    const coordenador = document.getElementById('vpf-coordenador').value.trim() || null;

    botaoModal.disabled = true;
    if (botao) botao.disabled = true;
    fecharModalFuncaoFormularioPessoal();

    const emLote = !!resumoLoteFormularios;
    try {
        await executarValidacaoFormularioPessoal(f, { funcao, liderId, localPrestacao, coordenador });
        if (emLote) resumoLoteFormularios.ok++;
        else await Promise.all([carregarFormularios(), carregarPessoal()]);
    } catch (e) {
        if (emLote) resumoLoteFormularios.erros.push(`${f.nome}: ${e.message}`);
        else alert('Não foi possível validar: ' + e.message);
    }
    botaoModal.disabled = false;
    if (botao) botao.disabled = false;

    if (emLote) { filaFuncaoLote.shift(); processarProximoDaFilaFuncao(); }
}

// Cria a pessoa em pessoal_contratado a partir do pré-cadastro. Lança em
// caso de erro no INSERT — quem chama decide alertar / recarregar.
// Multiplicador sem lider_id mas com f.lider_nome (fluxo do formulário do
// administrador): associa automaticamente ao líder de mesmo nome já
// cadastrado (cachePessoal precisa estar fresco — o lote recarrega antes).
async function executarValidacaoFormularioPessoal(f, { funcao, liderId = null, localPrestacao, coordenador = null }) {
    if (funcao === 'multiplicador' && !liderId && f.lider_nome) {
        const lider = liderPorNome(f.lider_nome);
        if (lider) liderId = lider.id;
    }
    const payload = {
        nome: nomeCaixaAlta(f.nome),
        cpf: f.cpf,
        endereco: enderecoCaixaAlta(f.endereco),
        telefone: f.telefone,
        cep: f.cep,
        funcao: funcao,
        lider_id: liderId,
        local_prestacao: localPrestacao === undefined ? f.local_prestacao : localPrestacao,
        descricao_atividades: ATRIBUICAO_ATIVIDADES_PESSOAL[funcao],
        coordenador: coordenador || null,
        data_inicio: '2026-08-15',
        data_fim: '2026-10-04',
        valor_contrato: VALOR_CONTRATO_PADRAO_PESSOAL[funcao] ?? VALOR_CONTRATO_PADRAO_PESSOAL.multiplicador,
        contabilizar_campanha: 0
    };

    // Move os documentos do pré-cadastro (CPF, comprovante de residência) do
    // bucket de entrada para "documentos-pessoal" e já vincula ao cadastro —
    // a URL vai no próprio INSERT (o validador não tem UPDATE nesse bucket).
    const cpfDigitos = apenasDigitos(f.cpf);
    const pastaPessoa = pastaDocumentosPessoal(payload.nome, cpfDigitos);
    const agora = Date.now();
    const caminhosMigrados = {};
    if (f.documento_cpf_path) {
        const ext = (f.documento_cpf_path.split('.').pop() || 'pdf').toLowerCase();
        const url = await migrarDocumentoFormulario(f.documento_cpf_path, 'documentos-pessoal', `${pastaPessoa}/comprovante_cpf_${agora}.${ext}`);
        if (url) { payload.comprovante_cpf_url = url; caminhosMigrados.documento_cpf_path = null; }
    }
    if (f.comprovante_residencia_path) {
        const ext = (f.comprovante_residencia_path.split('.').pop() || 'pdf').toLowerCase();
        const url = await migrarDocumentoFormulario(f.comprovante_residencia_path, 'documentos-pessoal', `${pastaPessoa}/comprovante_residencia_${agora}.${ext}`);
        if (url) { payload.comprovante_residencia_url = url; caminhosMigrados.comprovante_residencia_path = null; }
    }

    const { data: nova, error: erroInsert } = await supabaseClient.from('pessoal_contratado').insert(payload).select().single();
    if (erroInsert) throw new Error(erroInsert.message);

    const { error: erroUpdate } = await supabaseClient.from('formularios_pessoal')
        .update({ status: 'validado', pessoa_id: nova.id, ...caminhosMigrados }).eq('id', f.id);
    if (erroUpdate) console.warn('pessoa criada mas formulário não marcado como validado:', erroUpdate.message);
}

// Cria o veículo em `veiculos` a partir do pré-cadastro. Lança em caso de
// erro no INSERT — quem chama decide alertar / recarregar.
async function executarValidacaoFormularioVeiculo(f) {
    const lider = liderPorNome(f.nome_proprietario);
    const hoje = new Date();
    const dataHojeIso = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;

    const payload = {
        placa: f.placa,
        marca: f.marca || null,
        modelo: f.modelo || null,
        ano_fabricacao: f.ano_fabricacao || null,
        cnpj_associado: f.cnpj_associado || CNPJ_ASSOCIADO_PADRAO_VEICULO,
        nome_proprietario: lider ? nomeCaixaAlta(lider.nome) : (nomeCaixaAlta(f.nome_proprietario) || null),
        cpf_proprietario: lider ? mascararCPF(lider.cpf) : (f.cpf_proprietario || null),
        localidade_atendimento: lider ? lider.local_prestacao : null,
        lider_id: lider ? lider.id : null,
        valor_contratado: f.valor_contratado || VALOR_ALUGUEL_VEICULO_PADRAO,
        data_inicio_cessao: dataHojeIso
    };

    // Move o CRLV do bucket de entrada para "documentos-veiculo" e vincula ao
    // cadastro — URL no próprio INSERT (validador não tem UPDATE nesse bucket).
    const caminhosMigrados = {};
    if (f.documento_veiculo_path) {
        const ext = (f.documento_veiculo_path.split('.').pop() || 'pdf').toLowerCase();
        const pastaVeiculo = normalizarPlaca(f.placa) || String(Date.now());
        const url = await migrarDocumentoFormulario(f.documento_veiculo_path, 'documentos-veiculo', `${pastaVeiculo}/${Date.now()}.${ext}`);
        if (url) { payload.documento_url = url; caminhosMigrados.documento_veiculo_path = null; }
    }

    const { data: novo, error: erroInsert } = await supabaseClient.from('veiculos').insert(payload).select().single();
    if (erroInsert) throw new Error(erroInsert.message);

    const { error: erroUpdate } = await supabaseClient.from('formularios_veiculo')
        .update({ status: 'validado', veiculo_id: novo.id, ...caminhosMigrados }).eq('id', f.id);
    if (erroUpdate) console.warn('veículo criado mas formulário não marcado como validado:', erroUpdate.message);
}

async function validarFormularioVeiculo(id, botao) {
    const f = cacheFormulariosVeiculo.find(x => x.id === id);
    if (!f) return;
    const lider = liderPorNome(f.nome_proprietario);
    const aviso = lider ? ` Será associado ao líder ${lider.nome}.` : ' Nenhum líder cadastrado com esse nome — o veículo fica sem líder associado.';
    if (!confirm(`Validar o veículo placa "${f.placa}"?${aviso}`)) return;
    botao.disabled = true;
    try {
        await executarValidacaoFormularioVeiculo(f);
        await Promise.all([carregarFormularios(), carregarVeiculos()]);
    } catch (e) {
        alert('Não foi possível validar: ' + e.message);
    }
    botao.disabled = false;
}

// Mesmas cores/emoji da coluna "Tipo" na tela Formulários da plataforma
// principal (app.js#ROTULOS_TIPO_FORMULARIO) — mantenha em sincronia.
const ROTULOS_TIPO_FORMULARIO = {
    pessoal: { texto: '👤 Pessoal', cor: '#6d28d9', fundo: '#ede9fe' },
    veiculo: { texto: '🚗 Veículo', cor: '#b91c1c', fundo: '#fee2e2' }
};

function badgeTipoFormulario(tipo) {
    const tp = ROTULOS_TIPO_FORMULARIO[tipo];
    return `<span style="font-size:0.75rem; font-weight:700; padding:0.2rem 0.6rem; border-radius:999px; color:${tp.cor}; background:${tp.fundo}; white-space:nowrap;">${tp.texto}</span>`;
}

async function carregarFormularios() {
    const tbody = document.getElementById('formularios-body');
    inicializarFiltroColunas('tabela-formularios', [0, 9, 10]);
    const [{ data: pessoal, error: eP }, { data: veiculo, error: eV }] = await Promise.all([
        lerTodasAsPaginas((de, ate) => supabaseClient.from('formularios_pessoal').select('*').eq('status', 'pendente').order('id', { ascending: true }).range(de, ate)),
        lerTodasAsPaginas((de, ate) => supabaseClient.from('formularios_veiculo').select('*').eq('status', 'pendente').order('id', { ascending: true }).range(de, ate))
    ]);
    if (eP || eV) { tbody.innerHTML = linhaVazia(11, 'Erro ao carregar formulários.'); return; }
    cacheFormulariosPessoal = pessoal || [];
    cacheFormulariosVeiculo = veiculo || [];

    const podeValidar = possoValidarFormularios();
    const acoesLote = document.getElementById('formularios-acoes-lote');
    if (acoesLote) acoesLote.style.display = podeValidar ? 'flex' : 'none';

    const linhasPessoal = cacheFormulariosPessoal.map(f => `
        <tr>
            <td>${podeValidar ? `<input type="checkbox" class="chk-form" data-tipo="pessoal" value="${f.id}">` : ''}</td>
            <td>${badgeTipoFormulario('pessoal')}</td>
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
            <td>${podeValidar ? `<input type="checkbox" class="chk-form" data-tipo="veiculo" value="${f.id}">` : ''}</td>
            <td>${badgeTipoFormulario('veiculo')}</td>
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
    tbody.innerHTML = linhas.length ? linhas.join('') : linhaVazia(11, 'Nenhum formulário pendente.');
    aplicarFiltrosColuna('tabela-formularios');
}

// Marca/desmarca todas as checkboxes de uma classe que não estejam
// desabilitadas (usado pelos "marcar todos" dos cabeçalhos das telas de
// validação em lote).
function marcarTodosPendentes(classe, marcar) {
    document.querySelectorAll(`.${classe}:not(:disabled)`).forEach(c => { c.checked = marcar; });
}

// ─── VALIDAÇÃO EM LOTE — FORMULÁRIOS ────────────────────────────────────
// Veículos e Pessoal COM função validam direto (sem modal por item). As
// pré-inscrições de Pessoal SEM função (vindas do Cadastro Rápido) entram
// numa fila: o modal de função/coordenador abre uma vez para cada, em
// sequência. O Coordenador é perguntado UMA vez para o lote inteiro.
let filaFuncaoLote = [];
let resumoLoteFormularios = null;
let coordenadorLoteAtual = '';

async function validarFormulariosSelecionados(botao) {
    const marcados = Array.from(document.querySelectorAll('.chk-form:checked'));
    if (!marcados.length) { alert('Marque ao menos um formulário pendente.'); return; }

    const pessoalIds = marcados.filter(c => c.dataset.tipo === 'pessoal').map(c => Number(c.value));
    const veiculoIds = marcados.filter(c => c.dataset.tipo === 'veiculo').map(c => Number(c.value));
    if (!confirm(`Validar ${marcados.length} formulário(s) selecionado(s)?`)) return;

    let coordenadorLote = '';
    if (pessoalIds.length) {
        const resp = prompt('Coordenador desta turma? (texto livre — deixe em branco se não se aplica)', '');
        if (resp === null) { return; } // cancelou o lote
        coordenadorLote = resp.trim();
    }
    coordenadorLoteAtual = coordenadorLote;

    botao.disabled = true;
    const resumo = { ok: 0, pulados: 0, erros: [] };

    for (const id of veiculoIds) {
        const f = cacheFormulariosVeiculo.find(x => x.id === id);
        if (!f) { resumo.pulados++; continue; }
        try { await executarValidacaoFormularioVeiculo(f); resumo.ok++; }
        catch (e) { resumo.erros.push(`Veículo ${f.placa}: ${e.message}`); }
    }

    const pessoas = pessoalIds.map(id => cacheFormulariosPessoal.find(x => x.id === id)).filter(Boolean);
    const lideres = pessoas.filter(f => f.funcao === 'lider');
    const multiplicadores = pessoas.filter(f => f.funcao === 'multiplicador');
    const semFuncao = pessoas.filter(f => f.funcao !== 'lider' && f.funcao !== 'multiplicador');

    // 1º os líderes — assim os multiplicadores já podem casar pelo nome.
    for (const f of lideres) {
        try { await executarValidacaoFormularioPessoal(f, { funcao: 'lider', coordenador: coordenadorLote || null }); resumo.ok++; }
        catch (e) { resumo.erros.push(`${f.nome}: ${e.message}`); }
    }
    if (lideres.length) await carregarPessoal(); // atualiza cachePessoal com os líderes recém-criados

    // 2º os multiplicadores — líder pelo id, ou pelo nome (f.lider_nome).
    // Quem não resolve o líder cai na fila do modal.
    const multSemLider = [];
    for (const f of multiplicadores) {
        const temLider = f.lider_id || (f.lider_nome && liderPorNome(f.lider_nome));
        if (!temLider) { multSemLider.push(f); continue; }
        try { await executarValidacaoFormularioPessoal(f, { funcao: 'multiplicador', liderId: f.lider_id || null, coordenador: coordenadorLote || null }); resumo.ok++; }
        catch (e) { resumo.erros.push(`${f.nome}: ${e.message}`); }
    }

    botao.disabled = false;

    const paraFila = [...semFuncao, ...multSemLider];
    if (paraFila.length) {
        // Fila do modal — o resumo é mostrado quando a fila esvazia. O campo
        // Coordenador de cada modal vem pré-preenchido com coordenadorLote.
        filaFuncaoLote = paraFila;
        resumoLoteFormularios = resumo;
        processarProximoDaFilaFuncao();
        return;
    }

    await carregarFormularios();
    mostrarResumoLoteFormularios(resumo);
}

function processarProximoDaFilaFuncao() {
    if (!filaFuncaoLote.length) {
        const resumo = resumoLoteFormularios;
        resumoLoteFormularios = null;
        carregarFormularios().then(() => mostrarResumoLoteFormularios(resumo));
        return;
    }
    abrirModalFuncaoFormularioPessoal(filaFuncaoLote[0], null, coordenadorLoteAtual);
}

function mostrarResumoLoteFormularios(resumo) {
    let msg = `${resumo.ok} validado(s).`;
    if (resumo.pulados) msg += ` ${resumo.pulados} pulado(s).`;
    if (resumo.erros.length) msg += `\n\nNão validados:\n- ${resumo.erros.join('\n- ')}`;
    alert(msg);
}

// ─── CADASTRO RÁPIDO ────────────────────────────────────────────────────
// Rótulos do status de cada envio (mesma ideia de ROTULOS_STATUS_ENVIO_MULT).
const ROTULOS_STATUS_CADASTRO_RAPIDO = {
    pendente: 'Pendente', aproveitado: 'Aproveitado', rejeitado: 'Rejeitado'
};

let cacheCadastroRapido = [];

async function carregarCadastroRapido() {
    const tbody = document.getElementById('cadastro-rapido-body');
    inicializarFiltroColunas('tabela-cadastro-rapido', [0, 9]);
    const { data, error } = await lerTodasAsPaginas((de, ate) =>
        supabaseClient.from('formularios_cadastro_rapido').select('*').order('created_at', { ascending: false }).order('id', { ascending: false }).range(de, ate));
    if (error) { tbody.innerHTML = linhaVazia(10, 'Erro ao carregar cadastros.'); return; }
    cacheCadastroRapido = data || [];
    const podeAproveitar = possoValidarFormularios();
    const acoesLote = document.getElementById('cadastro-rapido-acoes-lote');
    const temPendente = cacheCadastroRapido.some(f => f.status === 'pendente');
    if (acoesLote) acoesLote.style.display = (podeAproveitar && temPendente) ? 'flex' : 'none';
    if (!cacheCadastroRapido.length) { tbody.innerHTML = linhaVazia(10, 'Nenhum cadastro recebido.'); aplicarFiltrosColuna('tabela-cadastro-rapido'); return; }

    tbody.innerHTML = cacheCadastroRapido.map(f => {
        const rotuloStatus = ROTULOS_STATUS_CADASTRO_RAPIDO[f.status] || f.status;
        const pendente = f.status === 'pendente';
        const acao = (podeAproveitar && pendente)
            ? `<button class="btn-icon" onclick="aproveitarCadastroRapido(${f.id}, this)" title="Aproveitar (criar pré-inscrição de Pessoal + Veículo)">✅</button>`
            : '—';
        return `
        <tr>
            <td>${podeAproveitar && pendente ? `<input type="checkbox" class="chk-cr" value="${f.id}">` : ''}</td>
            <td>${formatarData(f.created_at)}</td>
            <td>${escaparHtml(f.nome)}</td>
            <td>${escaparHtml(mascararCPF(f.cpf))}</td>
            <td>${escaparHtml(f.telefone)}</td>
            <td>${escaparHtml(f.local_prestacao)}</td>
            <td>${escaparHtml(f.placa)}</td>
            <td>${escaparHtml(f.modelo)}</td>
            <td>${escaparHtml(rotuloStatus)}</td>
            <td>${acao}</td>
        </tr>`;
    }).join('');

    aplicarFiltrosColuna('tabela-cadastro-rapido');
}

// "Aproveitar" um envio do Cadastro Rápido — espelha
// aproveitarEnvioCadastroRapido do app.js da plataforma principal: cria
// uma pré-inscrição em formularios_pessoal + uma em formularios_veiculo
// (status 'pendente'), que aí seguem o fluxo normal da tela Formulários
// (onde o validador confirma função, líder, valores etc.). A pré-inscrição
// de Pessoal entra sem função — o modal de validação em Formulários pede.
// Cria as duas pré-inscrições (Pessoal + Veículo) a partir de um envio.
// Pessoal primeiro; se o Veículo falhar, marca a linha de Pessoal como
// 'rejeitado' (o validador não tem DELETE nessas tabelas) e lança.
async function executarAproveitarCadastroRapido(envio) {
    let fpId = null;
    try {
        const { data: fp, error: eP } = await supabaseClient.from('formularios_pessoal').insert({
            nome: nomeCaixaAlta(envio.nome),
            cpf: envio.cpf,
            endereco: enderecoCaixaAlta(envio.endereco),
            telefone: envio.telefone,
            local_prestacao: envio.local_prestacao,
            lgpd_aceite: true,
            status: 'pendente'
        }).select().single();
        if (eP) throw new Error('pré-inscrição de Pessoal: ' + eP.message);
        fpId = fp.id;

        const { data: fv, error: eV } = await supabaseClient.from('formularios_veiculo').insert({
            placa: envio.placa,
            modelo: envio.modelo,
            nome_proprietario: nomeCaixaAlta(envio.nome),
            cpf_proprietario: envio.cpf,
            status: 'pendente'
        }).select().single();
        if (eV) throw new Error('pré-inscrição de Veículo: ' + eV.message);

        const { error: eU } = await supabaseClient.from('formularios_cadastro_rapido')
            .update({ status: 'aproveitado', formulario_pessoal_id: fpId, formulario_veiculo_id: fv.id })
            .eq('id', envio.id);
        if (eU) throw new Error('marcação do envio: ' + eU.message);
    } catch (erro) {
        if (fpId) {
            await supabaseClient.from('formularios_pessoal')
                .update({ status: 'rejeitado', motivo_rejeicao: 'Falha ao aproveitar o Cadastro Rápido (veículo não criado).' })
                .eq('id', fpId);
        }
        throw erro;
    }
}

async function aproveitarCadastroRapido(id, botao) {
    const envio = cacheCadastroRapido.find(e => e.id === id);
    if (!envio || envio.status !== 'pendente') return;
    if (!confirm(`Aproveitar o cadastro de "${envio.nome}"? Isso cria uma pré-inscrição de Pessoal e uma de Veículo, que você valida na tela Formulários.`)) return;
    if (botao) botao.disabled = true;
    try {
        await executarAproveitarCadastroRapido(envio);
        alert('Cadastro aproveitado. Valide as pré-inscrições na tela Formulários.');
    } catch (erro) {
        console.error('aproveitarCadastroRapido:', erro);
        alert('Não foi possível aproveitar o cadastro — ' + erro.message);
    }
    await Promise.all([carregarCadastroRapido(), carregarFormularios()]);
    if (botao) botao.disabled = false;
}

async function aproveitarCadastroRapidoSelecionados(botao) {
    const marcados = Array.from(document.querySelectorAll('.chk-cr:checked')).map(c => Number(c.value));
    if (!marcados.length) { alert('Marque ao menos um cadastro pendente.'); return; }
    if (!confirm(`Aproveitar ${marcados.length} cadastro(s)? Cada um vira uma pré-inscrição de Pessoal + Veículo, que você valida na tela Formulários.`)) return;

    botao.disabled = true;
    const resumo = { ok: 0, erros: [] };
    for (const id of marcados) {
        const envio = cacheCadastroRapido.find(e => e.id === id);
        if (!envio || envio.status !== 'pendente') continue;
        try { await executarAproveitarCadastroRapido(envio); resumo.ok++; }
        catch (e) { resumo.erros.push(`${envio.nome}: ${e.message}`); }
    }
    await Promise.all([carregarCadastroRapido(), carregarFormularios()]);
    botao.disabled = false;

    let msg = `${resumo.ok} cadastro(s) aproveitado(s). Valide as pré-inscrições na tela Formulários.`;
    if (resumo.erros.length) msg += `\n\nNão aproveitados:\n- ${resumo.erros.join('\n- ')}`;
    alert(msg);
}

// ─── MULTIPLICADORES (só validador/admin — ver possoValidarFormularios) ──
// Mesma lógica de lib/cadastroRapido.js + lib/multiplicadorFormulario.js,
// reimplementada aqui porque este site estático não carrega lib/ (mesmo
// padrão do resto do arquivo) — mantenha em sincronia se mudar lá.
const URL_FORMULARIO_MULTIPLICADOR = 'https://controlefinanceiro2026.github.io/formularios/multiplicador.html';
const EXPIRACAO_MINUTOS_MULTIPLICADOR = 20;

function formatarDataHoraMultiplicador(iso) {
    if (!iso) return '—';
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '—';
    const partes = new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(new Date(t)).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
    return `${partes.day}/${partes.month}/${partes.year} ${partes.hour}:${partes.minute}`;
}

function gerarTokenMultiplicador() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function linkMultiplicador(token) {
    return `${URL_FORMULARIO_MULTIPLICADOR}?t=${token}`;
}

const ROTULOS_ESTADO_LINK_MULTIPLICADOR = {
    nao_aberto: 'Não aberto', em_preenchimento: 'Em preenchimento', expirado: 'Expirado', enviado: 'Enviado'
};

function estadoLinkMultiplicador(link, agora = new Date()) {
    if (!link) return 'nao_aberto';
    if (link.enviado_em) return 'enviado';
    if (!link.aberto_em) return 'nao_aberto';
    const limite = Date.parse(link.aberto_em) + EXPIRACAO_MINUTOS_MULTIPLICADOR * 60000;
    return agora.getTime() <= limite ? 'em_preenchimento' : 'expirado';
}

function numeroWhatsApp(telefone) {
    const d = String(telefone || '').replace(/\D/g, '');
    if (d.length === 10 || d.length === 11) return `55${d}`;
    if ((d.length === 12 || d.length === 13) && d.startsWith('55')) return d;
    return null;
}

function linkWhatsApp(telefone, mensagem) {
    const numero = numeroWhatsApp(telefone);
    if (!numero) return null;
    return `https://wa.me/${numero}?text=${encodeURIComponent(mensagem)}`;
}

function mensagemPadraoMultiplicador(nomeLider, link) {
    return `Olá, ${nomeLider}! Segue o link para você cadastrar os 4 multiplicadores da sua célula: ${link}\n\n`
        + `O tempo de preenchimento desse formulário é de ${EXPIRACAO_MINUTOS_MULTIPLICADOR} minutos, dessa forma, é importante que você já tenha os dados dos multiplicadores da sua célula disponíveis (Nome, CPF, Telefone, Endereço). `
        + `O link é de uso único após aberto e expira em 12 horas. Pedimos agilidade na resposta.`;
}

let linksMultiplicadorCache = new Map(); // lider_id -> link mais recente
let cacheEnviosMultiplicador = [];

async function carregarMultiplicadores() {
    const tbodyLideres = document.getElementById('mult-lideres-body');
    const tbodyEnvios = document.getElementById('mult-envios-body');
    if (!tbodyLideres || !tbodyEnvios) return;
    tbodyLideres.innerHTML = linhaVazia(6, 'Carregando…');
    tbodyEnvios.innerHTML = linhaVazia(8, 'Carregando…');

    const [{ data: links, error: eL }, { data: envios, error: eE }] = await Promise.all([
        lerTodasAsPaginas((de, ate) => supabaseClient.from('links_multiplicador').select('*').order('gerado_em', { ascending: false }).order('id', { ascending: false }).range(de, ate)),
        lerTodasAsPaginas((de, ate) => supabaseClient.from('envios_multiplicador').select('*').order('created_at', { ascending: false }).order('id', { ascending: false }).range(de, ate))
    ]);
    if (eL) { tbodyLideres.innerHTML = linhaVazia(6, 'Erro ao carregar os links: ' + eL.message); }
    if (eE) { tbodyEnvios.innerHTML = linhaVazia(8, 'Erro ao carregar os envios: ' + eE.message); }

    const maisRecentePorLider = new Map();
    (links || []).forEach(l => {
        const atual = maisRecentePorLider.get(l.lider_id);
        if (!atual || new Date(l.gerado_em) > new Date(atual.gerado_em)) maisRecentePorLider.set(l.lider_id, l);
    });
    linksMultiplicadorCache = maisRecentePorLider;
    cacheEnviosMultiplicador = envios || [];

    if (!eL) renderLideresMultiplicador();
    if (!eE) renderEnviosMultiplicador();
}

function renderLideresMultiplicador() {
    const tbody = document.getElementById('mult-lideres-body');
    const termo = (document.getElementById('mult-lider-busca')?.value || '').trim().toLowerCase();
    const lideres = cachePessoal.filter(p => p.funcao === 'lider')
        .filter(p => !termo || String(p.nome).toLowerCase().includes(termo))
        .sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR'));

    if (!lideres.length) { tbody.innerHTML = linhaVazia(6, termo ? 'Nenhum líder encontrado para essa busca.' : 'Nenhum líder cadastrado ainda.'); return; }

    const agora = new Date();
    const cores = { nao_aberto: '#64748b', em_preenchimento: '#0e7490', expirado: '#b91c1c', enviado: '#15803d' };

    tbody.innerHTML = lideres.map(lider => {
        const link = linksMultiplicadorCache.get(lider.id) || null;
        const estado = link ? estadoLinkMultiplicador(link, agora) : null;
        const podeGerar = !link || estado === 'expirado' || estado === 'enviado';
        const urlLink = link ? linkMultiplicador(link.token) : '';
        const numeroWpp = (link && estado !== 'expirado' && lider.telefone) ? numeroWhatsApp(lider.telefone) : null;

        const celulaStatus = link
            ? `<span style="font-size:0.78rem; font-weight:700; color:${cores[estado]};">${ROTULOS_ESTADO_LINK_MULTIPLICADOR[estado]}</span>`
            : '<span class="text-muted">Nenhum link gerado</span>';

        const celulaWhatsApp = link && link.whatsapp_enviado_em
            ? `<span style="font-size:0.75rem; font-weight:700; color:#15803d;">✅ Enviado em ${escaparHtml(formatarDataHoraMultiplicador(link.whatsapp_enviado_em))}</span>`
            : '<span class="text-muted">—</span>';

        const botoes = [];
        if (podeGerar) {
            botoes.push(`<button type="button" class="btn-secondary" style="font-size:0.78rem; padding:0.4rem 0.7rem;" onclick="gerarLinkMultiplicador(${lider.id})">${link ? '🔄 Gerar novo link' : '🔗 Gerar link'}</button>`);
        }
        if (link && estado !== 'expirado') {
            botoes.push(`<button type="button" class="btn-secondary" style="font-size:0.78rem; padding:0.4rem 0.7rem;" onclick="copiarTextoMultiplicador('${escaparHtml(urlLink)}')">📋 Copiar</button>`);
            if (numeroWpp) {
                const rotuloWpp = link.whatsapp_enviado_em ? '💬 Reenviar por WhatsApp' : '💬 Enviar por WhatsApp';
                botoes.push(`<button type="button" class="btn-secondary" style="font-size:0.78rem; padding:0.4rem 0.7rem;" onclick="enviarWhatsAppMultiplicador(${lider.id})">${rotuloWpp}</button>`);
            }
        }

        return `
        <tr>
            <td><input type="checkbox" class="chk-lider-mult" value="${lider.id}" ${numeroWpp ? '' : 'disabled'}></td>
            <td><strong>${escaparHtml(lider.nome)}</strong></td>
            <td>${lider.telefone ? escaparHtml(lider.telefone) : '<span class="text-muted">Sem telefone</span>'}</td>
            <td>${celulaStatus}</td>
            <td>${celulaWhatsApp}</td>
            <td>${botoes.join(' ')}</td>
        </tr>`;
    }).join('');
}

async function copiarTextoMultiplicador(texto) {
    try { await navigator.clipboard.writeText(texto); }
    catch { alert('Não foi possível copiar automaticamente. Link: ' + texto); }
}

async function gerarLinkMultiplicador(liderId) {
    const { error } = await supabaseClient.from('links_multiplicador').insert({ lider_id: liderId, token: gerarTokenMultiplicador() });
    if (error) { alert('Erro ao gerar o link: ' + error.message); return; }
    await carregarMultiplicadores();
}

async function gerarLinksMultiplicadorTodos(botao) {
    const agora = new Date();
    const pendentes = cachePessoal.filter(p => p.funcao === 'lider').filter(lider => {
        const link = linksMultiplicadorCache.get(lider.id) || null;
        const estado = link ? estadoLinkMultiplicador(link, agora) : null;
        return !link || estado === 'expirado' || estado === 'enviado';
    });
    if (!pendentes.length) { alert('Todos os líderes já têm um link ativo no momento.'); return; }

    botao.disabled = true;
    const linhas = pendentes.map(lider => ({ lider_id: lider.id, token: gerarTokenMultiplicador() }));
    const { error } = await supabaseClient.from('links_multiplicador').insert(linhas);
    botao.disabled = false;
    if (error) { alert('Erro ao gerar os links: ' + error.message); return; }
    await carregarMultiplicadores();
}

// Grava whatsapp_enviado_em no link e atualiza a linha na tela — best
// effort: marca assim que a aba do wa.me é aberta, não há como confirmar
// que a mensagem foi de fato enviada a partir daqui.
async function marcarWhatsAppEnviadoMultiplicador(linkId) {
    const agoraIso = new Date().toISOString();
    const { error } = await supabaseClient.from('links_multiplicador')
        .update({ whatsapp_enviado_em: agoraIso }).eq('id', linkId);
    if (error) return;
    linksMultiplicadorCache.forEach(l => { if (l.id === linkId) l.whatsapp_enviado_em = agoraIso; });
    renderLideresMultiplicador();
}

function enviarWhatsAppMultiplicador(liderId) {
    const lider = cachePessoal.find(p => p.id === liderId);
    const link = linksMultiplicadorCache.get(liderId);
    if (!lider || !link) return;
    const numeroWpp = lider.telefone ? numeroWhatsApp(lider.telefone) : null;
    if (!numeroWpp) return;
    const urlLink = linkMultiplicador(link.token);
    const linkWpp = linkWhatsApp(lider.telefone, mensagemPadraoMultiplicador(lider.nome, urlLink));
    window.open(linkWpp, '_blank');
    marcarWhatsAppEnviadoMultiplicador(link.id);
}

// Abre uma aba wa.me por líder marcado (o wa.me só aceita um destinatário
// por link — não existe "envio em massa" sem a API paga do WhatsApp
// Business). O navegador pode bloquear as abas além da primeira; por isso
// o aviso na tela pedindo pra liberar pop-ups deste site.
async function enviarWhatsAppMultiplicadorSelecionados() {
    const ids = Array.from(document.querySelectorAll('.chk-lider-mult:checked')).map(c => Number(c.value));
    if (!ids.length) { alert('Marque ao menos um líder com WhatsApp disponível.'); return; }

    const agora = new Date();
    const linkIdsEnviados = [];
    ids.forEach(liderId => {
        const lider = cachePessoal.find(p => p.id === liderId);
        const link = linksMultiplicadorCache.get(liderId);
        if (!lider || !link) return;
        const estado = estadoLinkMultiplicador(link, agora);
        if (estado === 'expirado') return;
        const numeroWpp = lider.telefone ? numeroWhatsApp(lider.telefone) : null;
        if (!numeroWpp) return;
        const urlLink = linkMultiplicador(link.token);
        const linkWpp = linkWhatsApp(lider.telefone, mensagemPadraoMultiplicador(lider.nome, urlLink));
        window.open(linkWpp, '_blank');
        linkIdsEnviados.push(link.id);
    });

    if (linkIdsEnviados.length) {
        const agoraIso = agora.toISOString();
        await Promise.all(linkIdsEnviados.map(id => supabaseClient.from('links_multiplicador').update({ whatsapp_enviado_em: agoraIso }).eq('id', id)));
        linksMultiplicadorCache.forEach(l => { if (linkIdsEnviados.includes(l.id)) l.whatsapp_enviado_em = agoraIso; });
        renderLideresMultiplicador();
    } else {
        alert('Nenhum dos líderes selecionados tem link ativo com WhatsApp disponível.');
    }
}

const ROTULOS_STATUS_ENVIO_MULT = {
    pendente: 'Pendente', aproveitado: 'Validado', rejeitado: 'Rejeitado'
};

function renderEnviosMultiplicador() {
    const tbody = document.getElementById('mult-envios-body');
    const podeValidar = possoValidarFormularios();
    const btnLote = document.getElementById('mult-envios-validar-lote');
    if (btnLote) btnLote.hidden = !podeValidar || !cacheEnviosMultiplicador.some(e => e.status === 'pendente');
    if (!cacheEnviosMultiplicador.length) { tbody.innerHTML = linhaVazia(9, 'Nenhum liderado recebido ainda.'); return; }

    const nomeLiderPorId = new Map(cachePessoal.map(p => [p.id, p.nome]));

    tbody.innerHTML = cacheEnviosMultiplicador.map(e => {
        const pendente = e.status === 'pendente';
        const acao = pendente
            ? (podeValidar ? `<button class="btn-icon" onclick="validarEnvioMultiplicador(${e.id})" title="Validar">✅</button>` : '—')
            : (ROTULOS_STATUS_ENVIO_MULT[e.status] || e.status);
        return `
        <tr>
            <td>${podeValidar && pendente ? `<input type="checkbox" class="chk-envio-mult" value="${e.id}">` : ''}</td>
            <td>${formatarData(e.created_at)}</td>
            <td>${escaparHtml(nomeLiderPorId.get(e.lider_id) || '—')}</td>
            <td><strong>${escaparHtml(e.nome)}</strong></td>
            <td>${escaparHtml(mascararCPF(e.cpf))}</td>
            <td>${escaparHtml(e.telefone)}</td>
            <td>${escaparHtml(e.endereco)}</td>
            <td>${escaparHtml(ROTULOS_STATUS_ENVIO_MULT[e.status] || e.status)}</td>
            <td>${acao}</td>
        </tr>`;
    }).join('');
}

// Ao validar, o validador confirma (ou troca) o líder que o liderado fica
// associado — vem pré-selecionado no líder do link (envio.lider_id). A
// localidade do cadastro segue sempre o líder escolhido. Cria a pessoa
// direto em pessoal_contratado (função Multiplicador, valor fixo de
// R$ 1.600, vigência padrão da campanha), sem o passo "aproveitar" que a
// plataforma principal usa.
let envioMultiplicadorParaValidar = null;

function validarEnvioMultiplicador(id) {
    const envio = cacheEnviosMultiplicador.find(e => e.id === id);
    if (!envio || envio.status !== 'pendente') return;
    envioMultiplicadorParaValidar = envio;

    document.getElementById('mult-validar-nome').textContent = envio.nome;
    document.getElementById('mult-validar-cpf').textContent = ` · ${mascararCPF(envio.cpf)}`;

    const lideres = cachePessoal.filter(p => p.funcao === 'lider')
        .sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR'));
    const select = document.getElementById('mult-validar-lider');
    select.innerHTML = lideres.length
        ? lideres.map(l => `<option value="${l.id}">${escaparHtml(l.nome)}${l.local_prestacao ? ` — ${escaparHtml(l.local_prestacao)}` : ''}</option>`).join('')
        : '<option value="">Nenhum líder cadastrado</option>';
    select.value = String(envio.lider_id || '');

    const liderDoLink = cachePessoal.find(p => p.id === envio.lider_id);
    document.getElementById('mult-validar-lider-dica').textContent = liderDoLink
        ? `Link preenchido por ${liderDoLink.nome}.`
        : 'O líder do link não está mais cadastrado — escolha um.';

    document.getElementById('mult-validar-coordenador').value = '';
    document.getElementById('mult-validar-confirmar').disabled = !lideres.length;
    document.getElementById('modal-validar-multiplicador').classList.add('show');
}

function fecharModalValidarMultiplicador() {
    document.getElementById('modal-validar-multiplicador').classList.remove('show');
    envioMultiplicadorParaValidar = null;
}

// Cria o multiplicador em pessoal_contratado associado a liderId. Lança em
// caso de erro no INSERT — quem chama decide alertar / recarregar.
async function executarValidacaoMultiplicador(envio, liderId, coordenador = null) {
    const lider = cachePessoal.find(p => p.id === liderId) || null;
    const payload = {
        nome: nomeCaixaAlta(envio.nome),
        cpf: envio.cpf,
        endereco: enderecoCaixaAlta(envio.endereco),
        telefone: envio.telefone,
        funcao: 'multiplicador',
        lider_id: liderId,
        local_prestacao: lider ? lider.local_prestacao : null,
        descricao_atividades: ATRIBUICAO_ATIVIDADES_PESSOAL.multiplicador,
        coordenador: coordenador || null,
        data_inicio: '2026-08-15',
        data_fim: '2026-10-04',
        valor_contrato: VALOR_CONTRATO_PADRAO_PESSOAL.multiplicador,
        contabilizar_campanha: 0
    };
    const { data: nova, error: erroInsert } = await supabaseClient.from('pessoal_contratado').insert(payload).select().single();
    if (erroInsert) throw new Error(erroInsert.message);

    const { error: erroUpdate } = await supabaseClient.from('envios_multiplicador')
        .update({ status: 'aproveitado', pessoa_id: nova.id, lider_id: liderId }).eq('id', envio.id);
    if (erroUpdate) console.warn('multiplicador criado mas envio não marcado como validado:', erroUpdate.message);
}

async function confirmarValidacaoMultiplicador(botao) {
    const envio = envioMultiplicadorParaValidar;
    if (!envio) return;

    const liderId = Number(document.getElementById('mult-validar-lider').value) || null;
    if (!liderId) { alert('Escolha um líder para associar o multiplicador.'); return; }
    const coordenador = document.getElementById('mult-validar-coordenador').value.trim() || null;

    botao.disabled = true;
    try {
        await executarValidacaoMultiplicador(envio, liderId, coordenador);
        fecharModalValidarMultiplicador();
        await Promise.all([carregarMultiplicadores(), carregarPessoal()]);
    } catch (e) {
        alert('Não foi possível validar: ' + e.message);
    }
    botao.disabled = false;
}

// Valida em lote os liderados marcados usando o LÍDER DO PRÓPRIO LINK
// (envio.lider_id) — igual à plataforma principal. Liderado cujo líder do
// link não está mais cadastrado é pulado e listado no fim.
async function validarEnviosMultiplicadorSelecionados(botao) {
    const marcados = Array.from(document.querySelectorAll('.chk-envio-mult:checked')).map(c => Number(c.value));
    if (!marcados.length) { alert('Marque ao menos um liderado pendente.'); return; }
    if (!confirm(`Validar ${marcados.length} liderado(s)? Cada um é criado como Multiplicador associado ao líder do link.`)) return;

    const respCoord = prompt('Coordenador desta turma? (texto livre — deixe em branco se não se aplica)', '');
    if (respCoord === null) return;
    const coordenadorLote = respCoord.trim() || null;

    botao.disabled = true;
    const resumo = { ok: 0, erros: [] };
    for (const id of marcados) {
        const envio = cacheEnviosMultiplicador.find(e => e.id === id);
        if (!envio || envio.status !== 'pendente') continue;
        const lider = cachePessoal.find(p => p.id === envio.lider_id);
        if (!lider) { resumo.erros.push(`${envio.nome}: líder do link não está mais cadastrado — valide pelo ✅`); continue; }
        try { await executarValidacaoMultiplicador(envio, lider.id, coordenadorLote); resumo.ok++; }
        catch (e) { resumo.erros.push(`${envio.nome}: ${e.message}`); }
    }
    await Promise.all([carregarMultiplicadores(), carregarPessoal()]);
    botao.disabled = false;

    let msg = `${resumo.ok} liderado(s) validado(s).`;
    if (resumo.erros.length) msg += `\n\nNão validados:\n- ${resumo.erros.join('\n- ')}`;
    alert(msg);
}

// ─── CADASTRO DE PESSOAL ────────────────────────────────────────────────
async function carregarPessoal() {
    const tbody = document.getElementById('pessoal-body');
    inicializarFiltroColunas('tabela-pessoal', [10, 11]);
    // Paginado: pessoal_contratado já passa de 1000 linhas. O .order('id')
    // na RPC é o par do "order by id" dentro de leitor_listar_pessoal()
    // (ver supabase/migracao-painel-consulta-paginacao.sql) — garante a
    // paginação estável mesmo se a migração ainda não tiver sido aplicada.
    const { data, error } = await lerTodasAsPaginas((de, ate) =>
        supabaseClient.rpc('leitor_listar_pessoal').order('id', { ascending: true }).range(de, ate));
    if (error) { tbody.innerHTML = linhaVazia(12, 'Erro ao carregar Pessoal.'); return; }
    cachePessoal = data || [];
    if (!cachePessoal.length) { tbody.innerHTML = linhaVazia(12, 'Nenhuma pessoa cadastrada.'); aplicarFiltrosColuna('tabela-pessoal'); return; }

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
            <td>${escaparHtml(p.coordenador || '—')}</td>
            <td>${escaparHtml(p.jornada_trabalho)}</td>
            <td>${p.data_inicio ? formatarData(p.data_inicio) : '—'}</td>
            <td>${p.data_fim ? formatarData(p.data_fim) : '—'}</td>
            <td>${p.valor_contrato ? formatarMoeda(p.valor_contrato) : '—'}</td>
            <td>
                ${caminhoContrato ? `<button class="btn-icon" onclick="visualizarDocumento('documentos-pessoal','${caminhoContrato}','Contrato assinado — ${escaparHtml(p.nome)}')" title="Ver contrato assinado">📎</button>` : ''}
                ${caminhoComprovanteCpf ? `<button class="btn-icon" onclick="visualizarDocumento('documentos-pessoal','${caminhoComprovanteCpf}','CPF — ${escaparHtml(p.nome)}')" title="Ver documento de CPF">🪪</button>` : ''}
                ${caminhoComprovanteResidencia ? `<button class="btn-icon" onclick="visualizarDocumento('documentos-pessoal','${caminhoComprovanteResidencia}','Comprovante de Residência — ${escaparHtml(p.nome)}')" title="Ver comprovante de residência">🏠</button>` : ''}
                ${!caminhoContrato && !caminhoComprovanteCpf && !caminhoComprovanteResidencia ? '<span style="color:#cbd5e1;">—</span>' : ''}
            </td>
            <td><button class="btn-icon" onclick="gerarContratoPessoal(cachePessoal.find(x => x.id === ${p.id}))" title="${caminhoContrato ? 'Ver contrato assinado' : 'Gerar Contrato de Prestação de Serviços'}">📄</button></td>
        </tr>`;
    }).join('');

    aplicarFiltrosColuna('tabela-pessoal');
}

// ─── CADASTRO DE VEÍCULOS ───────────────────────────────────────────────
async function carregarVeiculos() {
    const tbody = document.getElementById('veiculos-body');
    inicializarFiltroColunas('tabela-veiculos', [6, 7]);
    // Paginado (placa não é única — desempate por id pra o range() não pular linha).
    const { data, error } = await lerTodasAsPaginas((de, ate) =>
        supabaseClient.from('veiculos').select('*').order('placa').order('id', { ascending: true }).range(de, ate));
    if (error) { tbody.innerHTML = linhaVazia(8, 'Erro ao carregar Veículos.'); return; }
    cacheVeiculos = data || [];
    if (!cacheVeiculos.length) { tbody.innerHTML = linhaVazia(8, 'Nenhum veículo cadastrado.'); aplicarFiltrosColuna('tabela-veiculos'); return; }

    tbody.innerHTML = cacheVeiculos.map(v => {
        const caminhoDocumento = caminhoDoBucket(v.documento_url, 'documentos-veiculo');
        const caminhoTermo = caminhoDoBucket(v.termo_cessao_url, 'documentos-veiculo');
        const botoesDoc = [
            caminhoDocumento ? `<button class="btn-icon" onclick="visualizarDocumento('documentos-veiculo','${caminhoDocumento}','CRLV — ${escaparHtml(v.placa)}')" title="Ver documento do veículo (CRLV)">📎</button>` : '',
            caminhoTermo ? `<button class="btn-icon" onclick="visualizarDocumento('documentos-veiculo','${caminhoTermo}','Termo de Cessão assinado — ${escaparHtml(v.placa)}')" title="Ver Termo de Cessão assinado">📝</button>` : ''
        ].filter(Boolean).join(' ');
        return `
        <tr>
            <td>${escaparHtml(v.placa)}</td>
            <td>${escaparHtml(`${v.marca || ''} ${v.modelo || ''}`.trim() || '—')}</td>
            <td>${escaparHtml(v.nome_proprietario)}</td>
            <td>${escaparHtml(v.cnpj_associado)}</td>
            <td>${escaparHtml(v.localidade_atendimento)}</td>
            <td>${v.valor_contratado != null ? formatarMoeda(v.valor_contratado) : '—'}</td>
            <td>${botoesDoc || '<span style="color:#cbd5e1;">—</span>'}</td>
            <td><button class="btn-icon" onclick="gerarTermoCessaoVeiculo(cacheVeiculos.find(x => x.id === ${v.id}))" title="Gerar Termo de Cessão (modelo em branco)">📄</button></td>
        </tr>`;
    }).join('');

    aplicarFiltrosColuna('tabela-veiculos');
}

// ─── CONSULTA RÁPIDA ────────────────────────────────────────────────────
// Busca somente-leitura em cima do que já está em cachePessoal /
// cacheVeiculos (não faz request próprio). Pessoa: por CPF; Veículo: por
// placa. Os campos já entram com a máscara de CPF / placa. Um botão
// Desktop/Celular deixa o usuário forçar o layout de uma coluna (sem
// rolagem lateral) mesmo num tablet ou numa janela larga.
let crTipoConsulta = 'pessoa';

// Link (reutilizável, não expira — é o link do administrador do Cadastro
// Rápido) para cadastrar um líder + o veículo dele quando a consulta não
// acha nada. Ver [[project_cadastro_rapido_link_unico]].
const URL_CADASTRO_RAPIDO_LIDER = 'https://controlefinanceiro2026.github.io/formularios/cadastro.html?t=98c2027ebc56f2a81545ea010d614f31';

function crAviso(texto) {
    return `<div class="cr-aviso">${escaparHtml(texto)}</div>`;
}

// Aviso de "não encontrado" com o atalho pro formulário de cadastro do
// líder (Pessoal + Veículo numa tela só).
function crAvisoNaoEncontrado(texto) {
    return `<div class="cr-aviso">
        <p>${escaparHtml(texto)}</p>
        <p class="cr-aviso-sub">Se for um <strong>líder</strong>, cadastre a pessoa e o veículo dela pelo formulário:</p>
        <a class="cr-btn-cadastrar" href="${URL_CADASTRO_RAPIDO_LIDER}" target="_blank" rel="noopener">➕ Cadastrar líder e veículo</a>
    </div>`;
}

function crLinha(rotulo, valor) {
    return `<div class="cr-linha"><span class="cr-rotulo">${escaparHtml(rotulo)}</span>` +
        `<span class="cr-valor">${escaparHtml(valor == null || valor === '' ? '—' : valor)}</span></div>`;
}

function crRotuloFuncao(funcao) {
    if (funcao === 'lider') return 'Líder';
    if (funcao === 'multiplicador') return 'Multiplicador';
    return funcao || '—';
}

function crRenderPessoa(p) {
    const linhas = [
        crLinha('Nome', p.nome),
        crLinha('CPF', mascararCPF(p.cpf)),
        crLinha('Telefone', p.telefone),
        crLinha('Função', crRotuloFuncao(p.funcao))
    ];
    if (p.funcao === 'multiplicador') {
        const lider = p.lider_id ? cachePessoal.find(x => x.id === p.lider_id) : null;
        linhas.push(crLinha('Líder associado', lider ? lider.nome : '—'));
    }
    linhas.push(crLinha('Endereço', p.endereco));
    linhas.push(crLinha('Localidade', p.local_prestacao));
    return `<div class="cr-card"><div class="cr-card-head">👤 ${escaparHtml(p.nome)}</div>${linhas.join('')}</div>`;
}

function crRenderVeiculo(v) {
    const lider = v.lider_id ? cachePessoal.find(x => x.id === v.lider_id) : null;
    const nomeLider = lider ? lider.nome : (v.nome_proprietario || '—');
    const marcaModelo = `${v.marca || ''} ${v.modelo || ''}`.trim() || '—';
    const linhas = [
        crLinha('Placa', v.placa),
        crLinha('Líder associado', nomeLider),
        crLinha('Localidade', v.localidade_atendimento),
        crLinha('Marca/Modelo', marcaModelo)
    ];
    return `<div class="cr-card"><div class="cr-card-head">🚗 ${escaparHtml(v.placa)}</div>${linhas.join('')}</div>`;
}

function crConsultar(evento) {
    if (evento) evento.preventDefault();
    const alvo = document.getElementById('cr-resultado');

    if (!dadosProntos) {
        alvo.innerHTML = crAviso('Os dados ainda estão carregando. Tente de novo em alguns instantes.');
        return;
    }

    if (crTipoConsulta === 'pessoa') {
        const digitos = apenasDigitos(document.getElementById('cr-input-cpf').value);
        if (digitos.length !== 11) {
            alvo.innerHTML = crAviso('Digite um CPF completo (11 dígitos).');
            return;
        }
        const pessoa = cachePessoal.find(p => apenasDigitos(p.cpf) === digitos);
        alvo.innerHTML = pessoa
            ? crRenderPessoa(pessoa)
            : crAvisoNaoEncontrado('Nenhum líder ou multiplicador cadastrado com esse CPF.');
        return;
    }

    const placa = normalizarPlaca(document.getElementById('cr-input-placa').value);
    if (placa.length !== 7) {
        alvo.innerHTML = crAviso('Digite uma placa completa (7 caracteres).');
        return;
    }
    const veiculo = cacheVeiculos.find(v => normalizarPlaca(v.placa) === placa);
    alvo.innerHTML = veiculo
        ? crRenderVeiculo(veiculo)
        : crAvisoNaoEncontrado('Nenhum veículo cadastrado com essa placa.');
}

function crSelecionarTipo(tipo, comFoco) {
    crTipoConsulta = tipo;
    document.querySelectorAll('#cr-tipo button').forEach(b => b.classList.toggle('ativo', b.dataset.tipo === tipo));
    document.getElementById('cr-campo-pessoa').hidden = tipo !== 'pessoa';
    document.getElementById('cr-campo-veiculo').hidden = tipo !== 'veiculo';
    document.getElementById('cr-resultado').innerHTML = '';
    if (comFoco) {
        const foco = document.getElementById(tipo === 'pessoa' ? 'cr-input-cpf' : 'cr-input-placa');
        if (foco) foco.focus();
    }
}

function crSelecionarDispositivo(disp) {
    document.getElementById('cr-consulta').classList.toggle('cr-modo-celular', disp === 'celular');
    document.querySelectorAll('#cr-dispositivo button').forEach(b => b.classList.toggle('ativo', b.dataset.disp === disp));
    try { localStorage.setItem('cr-dispositivo', disp); } catch (e) { /* modo privado */ }
}

function crInicializar() {
    document.getElementById('cr-input-cpf').addEventListener('input', e => { e.target.value = mascararCPF(e.target.value); });
    document.getElementById('cr-input-placa').addEventListener('input', e => { e.target.value = normalizarPlaca(e.target.value); });
    document.querySelectorAll('#cr-tipo button').forEach(b => b.addEventListener('click', () => crSelecionarTipo(b.dataset.tipo, true)));
    document.querySelectorAll('#cr-dispositivo button').forEach(b => b.addEventListener('click', () => crSelecionarDispositivo(b.dataset.disp)));
    document.getElementById('cr-form').addEventListener('submit', crConsultar);

    let disp = null;
    try { disp = localStorage.getItem('cr-dispositivo'); } catch (e) { /* modo privado */ }
    if (disp !== 'desktop' && disp !== 'celular') {
        disp = (window.matchMedia && window.matchMedia('(max-width: 640px)').matches) ? 'celular' : 'desktop';
    }
    crSelecionarDispositivo(disp);
    crSelecionarTipo('pessoa');
}

document.addEventListener('DOMContentLoaded', async () => {
    const sessao = await exigirSessao();
    if (!sessao) return;
    document.getElementById('user-email').textContent = sessao.user.email;
    configurarNavegacao();
    crInicializar();
    await carregarPapel();
    // 'leitor' só enxerga Consulta Rápida e Formulários.
    aplicarRestricoesDeNavegacao();
    // Aba "Multiplicadores" só aparece pra quem pode validar (validador ou
    // admin) — mesma regra do botão "Validar" nas outras telas.
    const podeVerMultiplicadores = possoValidarFormularios();
    document.getElementById('nav-multiplicadores').style.display = podeVerMultiplicadores ? '' : 'none';
    // Pessoal carrega antes de Formulários/Multiplicadores: validar um
    // veículo/multiplicador precisa da lista de líderes já em cachePessoal
    // pra casar o proprietário/líder. Pessoal + Veículos também alimentam a
    // Consulta Rápida, então carregam mesmo pro 'leitor' (as telas ficam
    // ocultas, mas os caches são usados na busca).
    await carregarPessoal();
    const tarefas = [carregarFormularios(), carregarVeiculos()];
    if (!ehLeitor()) tarefas.push(carregarCadastroRapido());
    if (podeVerMultiplicadores) tarefas.push(carregarMultiplicadores());
    await Promise.all(tarefas);

    // Pessoal + Veículos já em cache: a Consulta Rápida pode responder.
    dadosProntos = true;
});
