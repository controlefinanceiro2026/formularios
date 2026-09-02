// Formulário público de Controle de Km — hospedado no GitHub Pages, sem
// servidor próprio. Grava direto no Supabase (chave "anon public" — só
// INSERT, graças ao RLS de supabase/schema-formulario-km.sql). A lista de
// veículos vem de veiculos-snapshot.json, publicado pelo sistema local da
// campanha (Controle de Km → "Publicar lista para formulário público").
// O sistema local puxa esses envios periodicamente e os importa como
// leituras de km — nomeando as fotos do veículo antes de subir para o
// bucket definitivo (FOTO_{PLACA}_CONTROLE_{DDMMAAAA}).

const SEM_LOCALIDADE = 'Sem localidade definida';
const TAMANHO_MAX_FOTO = 10 * 1024 * 1024; // 10 MB por foto
const MIN_FOTOS = 1;
const MAX_FOTOS = 3; // o líder de campo anexa de 1 a 3 fotos do veículo
const VALIDADE_LINK_HORAS = 24; // o link vale 1 dia a partir da publicação da lista

// Mesma regra de lib/kmFormulario.js#snapshotExpirado — reimplementada
// porque o formulário público tem deploy isolado. Sem gerado_em válido não
// expira (compat. com snapshot antigo).
function snapshotExpirado(geradoEm) {
    const t = Date.parse(geradoEm);
    if (!Number.isFinite(t)) return false;
    return (Date.now() - t) > VALIDADE_LINK_HORAS * 3600 * 1000;
}

const supabaseClient = window.supabase.createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey);

// Nome do responsável pelas informações, guardado no aparelho do líder de
// campo pra vir preenchido nas próximas vezes (editável no campo do
// formulário e no modal).
const CHAVE_RESPONSAVEL = 'km-responsavel';

function lerResponsavelSalvo() {
    try { return (localStorage.getItem(CHAVE_RESPONSAVEL) || '').trim(); } catch (e) { return ''; }
}

function salvarResponsavel(valor) {
    const limpo = String(valor || '').trim();
    try {
        if (limpo) localStorage.setItem(CHAVE_RESPONSAVEL, limpo);
        else localStorage.removeItem(CHAVE_RESPONSAVEL);
    } catch (e) { /* modo privado / storage bloqueado — segue sem persistir */ }
}

// Estado por veículo (índice = posição no snapshot).
let veiculos = [];
const enviados = {}; // idx -> true depois de enviado com sucesso
// idx dos veículos travados porque o Supabase já tem um envio deles nesta
// data (qualquer aparelho) — some/reaparece quando a data muda.
const travadosPorEnvioDoDia = new Set();
// idx -> File[] com as fotos escolhidas pra aquele veículo. O líder de
// campo pode adicionar/remover/trocar à vontade ATÉ enviar; depois do
// envio a linha trava e não dá mais pra mexer.
const fotosPorLinha = {};

// Lista por equipe ativa (quando a URL tem ?lista=<slug>): { nome, localidades }.
// Sem ?lista, o formulário mostra todos os veículos (uso do admin / link antigo).
let listaAtiva = null;

// Mesma regra de lib/kmFormulario.js#filtrarVeiculosPorLocalidades — aqui
// reimplementada porque o formulário público tem deploy isolado e não
// carrega aquele arquivo. Veículos sem localidade definida entram em TODA
// lista, pra nenhum carro cadastrado ficar fora de todos os formulários.
function filtrarVeiculosPorLocalidades(lista, localidades) {
    if (!localidades || !localidades.length) return lista.slice();
    const permitidas = new Set(localidades.map(l => String(l)));
    return lista.filter(v => permitidas.has(String(v.localidade)) || String(v.localidade) === SEM_LOCALIDADE);
}

// ---------- helpers de formatação ----------
function mascararData(valor) {
    return String(valor || '').replace(/\D/g, '').slice(0, 8)
        .replace(/(\d{2})(\d)/, '$1/$2')
        .replace(/(\d{2}\/\d{2})(\d)/, '$1/$2');
}

// "DD/MM/AAAA" -> "AAAA-MM-DD" (ou null se incompleta/inválida)
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

function fmtKm(n) {
    return (n === null || n === undefined || n === '') ? '—' : Number(n).toLocaleString('pt-BR');
}

function sanitizarSegmentoCaminho(valor) {
    return String(valor || '')
        .normalize('NFD').replace(/\p{Diacritic}/gu, '')
        .trim().replace(/[^A-Za-z0-9._-]+/g, '-') || 'sem-nome';
}

function extensaoImagem(arquivo) {
    if (arquivo.type === 'image/png') return 'png';
    if (arquivo.type === 'image/jpeg') return 'jpg';
    const ext = (arquivo.name.split('.').pop() || '').toLowerCase();
    return (ext === 'png' || ext === 'jpg' || ext === 'jpeg') ? (ext === 'jpeg' ? 'jpg' : ext) : 'jpg';
}

// km rodado = km no dia − km atual; null se não dá pra calcular ainda.
function calcularKmRodado(kmAtual, kmNoDia) {
    if (kmAtual === null || kmAtual === undefined || kmAtual === '') return null;
    const atual = Number(kmAtual);
    const noDia = Number(kmNoDia);
    if (kmNoDia === '' || kmNoDia === null || kmNoDia === undefined || !Number.isFinite(atual) || !Number.isFinite(noDia)) return null;
    return noDia - atual;
}

function agruparPorLocalidade(lista) {
    const grupos = [];
    lista.forEach(item => {
        const ultimo = grupos[grupos.length - 1];
        if (ultimo && ultimo.localidade === item.veiculo.localidade) ultimo.itens.push(item);
        else grupos.push({ localidade: item.veiculo.localidade, itens: [item] });
    });
    return grupos;
}

// ---------- mensagens ----------
function mostrarMensagem(texto, tipo) {
    const el = document.getElementById('km-mensagem');
    el.textContent = texto;
    el.className = `fp-msg ${tipo}`;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function limparMensagem() {
    const el = document.getElementById('km-mensagem');
    el.textContent = '';
    el.className = 'fp-msg';
}

// Mostra um aviso (pendência, erro de envio ou confirmação de sucesso)
// logo abaixo do próprio veículo, sem rolar a tela até o rodapé.
// block:'nearest' só reposiciona se a linha estiver fora de vista. O aviso
// de sucesso some sozinho depois de alguns segundos (a linha já fica verde
// com "✓ Enviado").
function mostrarAvisoLinha(idx, texto, tipo, rolar) {
    const tr = document.getElementById(`km-erro-${idx}`);
    if (!tr) return;
    const box = tr.querySelector('.km-erro-box');
    box.textContent = texto;
    box.classList.toggle('sucesso', tipo === 'sucesso');
    box.classList.toggle('info', tipo === 'info');
    tr.style.display = '';
    // block:'nearest' só reposiciona se a linha estiver fora de vista.
    if (rolar !== false) tr.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    clearTimeout(tr._timerAviso);
    if (tipo === 'sucesso') {
        tr._timerAviso = setTimeout(() => limparErroLinha(idx), 4000);
    }
}

function mostrarErroLinha(idx, texto) { mostrarAvisoLinha(idx, texto, 'erro'); }
function mostrarSucessoLinha(idx, texto) { mostrarAvisoLinha(idx, texto, 'sucesso'); }
// Nota passiva (veículo já enviado hoje) — não rola a tela.
function mostrarInfoLinha(idx, texto) { mostrarAvisoLinha(idx, texto, 'info', false); }

function limparErroLinha(idx) {
    const tr = document.getElementById(`km-erro-${idx}`);
    if (!tr) return;
    clearTimeout(tr._timerAviso);
    tr.style.display = 'none';
    const box = tr.querySelector('.km-erro-box');
    box.textContent = '';
    box.classList.remove('sucesso', 'info');
}

// ---------- render ----------
function linhaId(idx) { return `km-linha-${idx}`; }

function renderTabelas() {
    const container = document.getElementById('km-tabelas');
    const itens = veiculos.map((v, idx) => ({ veiculo: v, idx }));

    if (itens.length === 0) {
        container.innerHTML = '<div class="fp-msg info" style="display:block;">Nenhum veículo na lista publicada. Fale com a administração da campanha.</div>';
        return;
    }

    Object.keys(fotosPorLinha).forEach(k => delete fotosPorLinha[k]);
    const grupos = agruparPorLocalidade(itens);
    container.innerHTML = grupos.map(g => `
        <div class="km-grupo" data-localidade="${encodeURIComponent(g.localidade)}">
            <div class="km-localidade-titulo">${g.localidade}</div>
            <div class="km-tabela-wrap">
                <table class="km-tabela">
                    <thead>
                        <tr>
                            <th>Placa</th><th>Proprietário</th><th>Km Atual</th>
                            <th>Km no Dia *</th><th>Km Rodado</th><th>Fotos do Veículo * (1 a 3)</th><th>Observações</th><th></th>
                        </tr>
                    </thead>
                    <tbody>
                        ${g.itens.map(({ veiculo: v, idx }) => `
                            <tr id="${linhaId(idx)}" data-idx="${idx}">
                                <td class="km-td-placa" data-label="Placa"><strong>${v.placa}</strong></td>
                                <td data-label="Proprietário">${v.nome_proprietario || '—'}</td>
                                <td data-label="Km atual">${fmtKm(v.km_atual)}</td>
                                <td data-label="Km no dia *"><input type="number" class="km-no-dia" min="0" step="1" placeholder="Ex: 45230"></td>
                                <td class="km-rodado" data-label="Km rodado">—</td>
                                <td class="km-td-bloco" data-label="Fotos do veículo * (1 a 3)">
                                    <input type="file" class="km-foto" accept="image/png,image/jpeg" multiple hidden>
                                    <button type="button" class="btn-secondary km-add-foto" data-idx="${idx}">📷 Adicionar foto</button>
                                    <span class="km-fotos-ajuda">Até 3 fotos (JPG ou PNG). Toque no ✕ para remover antes de enviar.</span>
                                    <div class="km-fotos-previa" data-idx="${idx}"></div>
                                </td>
                                <td class="km-td-bloco" data-label="Observações"><textarea class="km-obs" rows="1" maxlength="500" placeholder="Opcional"></textarea></td>
                                <td class="km-td-bloco km-td-acao"><button type="button" class="btn-primary km-btn-linha" data-idx="${idx}">Enviar dados do veículo</button></td>
                            </tr>
                            <tr class="km-erro-linha" id="km-erro-${idx}" style="display:none">
                                <td colspan="8"><div class="km-erro-box"></div></td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        </div>
    `).join('');

    container.querySelectorAll('.km-no-dia').forEach(inp => inp.addEventListener('input', onKmNoDiaInput));
    container.querySelectorAll('.km-foto').forEach(inp => inp.addEventListener('change', onFotosSelecionadas));
    container.querySelectorAll('.km-add-foto').forEach(btn => btn.addEventListener('click', () => {
        btn.closest('tr').querySelector('.km-foto').click();
    }));
    container.querySelectorAll('.km-btn-linha').forEach(btn => btn.addEventListener('click', () => enviarLinha(Number(btn.dataset.idx))));

    aplicarFiltros();
}

function onKmNoDiaInput(e) {
    const tr = e.target.closest('tr');
    const idx = Number(tr.dataset.idx);
    const rodado = calcularKmRodado(veiculos[idx].km_atual, e.target.value);
    const cel = tr.querySelector('.km-rodado');
    if (rodado === null) { cel.textContent = '—'; cel.className = 'km-rodado'; return; }
    cel.textContent = `${rodado.toLocaleString('pt-BR')} km`;
    cel.className = rodado < 0 ? 'km-rodado km-rodado-neg' : 'km-rodado';
}

// Duas fotos são "a mesma" se batem nome + tamanho + data de modificação —
// evita duplicar quando o líder abre o seletor e escolhe o mesmo arquivo.
function mesmaFoto(a, b) {
    return a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
}

// O líder escolheu arquivos no seletor: acrescenta aos que já estão na
// linha (respeitando o limite de 3) e redesenha as miniaturas.
function onFotosSelecionadas(e) {
    const idx = Number(e.target.closest('tr').dataset.idx);
    const atuais = fotosPorLinha[idx] || (fotosPorLinha[idx] = []);
    Array.from(e.target.files).forEach(arquivo => {
        if (!['image/png', 'image/jpeg'].includes(arquivo.type)) return;
        if (atuais.length >= MAX_FOTOS) return;
        if (atuais.some(f => mesmaFoto(f, arquivo))) return;
        atuais.push(arquivo);
    });
    e.target.value = ''; // permite re-selecionar o mesmo arquivo depois
    renderFotosLinha(idx);
}

function removerFoto(idx, posicao) {
    if (!fotosPorLinha[idx]) return;
    fotosPorLinha[idx].splice(posicao, 1);
    renderFotosLinha(idx);
}

// Redesenha as miniaturas + botão ✕ de uma linha, e liga/desliga o botão
// "Adicionar foto" conforme o limite de 3.
function renderFotosLinha(idx) {
    const tr = document.getElementById(linhaId(idx));
    if (!tr) return;
    const box = tr.querySelector('.km-fotos-previa');
    box.querySelectorAll('img').forEach(img => URL.revokeObjectURL(img.src));
    box.innerHTML = '';

    const arquivos = fotosPorLinha[idx] || [];
    const travada = !!enviados[idx];
    arquivos.forEach((arquivo, i) => {
        const item = document.createElement('div');
        item.className = 'km-foto-item';
        const img = document.createElement('img');
        img.className = 'km-foto-previa';
        img.alt = '';
        img.src = URL.createObjectURL(arquivo);
        item.appendChild(img);
        if (!travada) {
            const x = document.createElement('button');
            x.type = 'button';
            x.className = 'km-foto-remover';
            x.textContent = '✕';
            x.title = 'Remover esta foto';
            x.addEventListener('click', () => removerFoto(idx, i));
            item.appendChild(x);
        }
        box.appendChild(item);
    });

    const addBtn = tr.querySelector('.km-add-foto');
    if (addBtn) {
        addBtn.disabled = travada || arquivos.length >= MAX_FOTOS;
        addBtn.textContent = arquivos.length ? '📷 Adicionar outra foto' : '📷 Adicionar foto';
    }
}

function preencherFiltroLocalidades() {
    const select = document.getElementById('km-filtro-localidade');
    const vistas = [];
    veiculos.forEach(v => { if (!vistas.includes(v.localidade)) vistas.push(v.localidade); });
    vistas.forEach(loc => {
        const opt = document.createElement('option');
        opt.value = loc; opt.textContent = loc;
        select.appendChild(opt);
    });

    // Numa lista de uma região só, o filtro não tem função — esconde.
    if (listaAtiva && vistas.length <= 1) {
        select.closest('.form-group').style.display = 'none';
    }
}

// Só letras/dígitos, em maiúsculas — pra pesquisa de placa "solta"
// (ignora hífen, espaço, caixa: "abc 1d23" acha "ABC1D23").
function normalizarPlacaBusca(valor) {
    return String(valor || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Aplica os dois filtros ao mesmo tempo: localidade (select) e placa
// (busca dinâmica). Um grupo de localidade some quando nenhuma das suas
// linhas passa nos filtros.
function aplicarFiltros() {
    const alvoLoc = document.getElementById('km-filtro-localidade').value;
    const termoPlaca = normalizarPlacaBusca(document.getElementById('km-filtro-placa').value);
    let algumaLinhaVisivel = false;

    document.querySelectorAll('.km-grupo').forEach(g => {
        const loc = decodeURIComponent(g.dataset.localidade);
        const localidadeBate = !alvoLoc || alvoLoc === loc;
        let algumaNoGrupo = false;
        g.querySelectorAll('tr[data-idx]').forEach(tr => {
            const idx = Number(tr.dataset.idx);
            const placa = normalizarPlacaBusca(veiculos[idx].placa);
            const visivel = localidadeBate && (!termoPlaca || placa.includes(termoPlaca));
            tr.style.display = visivel ? '' : 'none';
            // A linha de erro do veículo acompanha: some junto quando ele é
            // filtrado (ela só reaparece numa nova tentativa de envio).
            if (!visivel) limparErroLinha(idx);
            if (visivel) { algumaNoGrupo = true; algumaLinhaVisivel = true; }
        });
        g.style.display = algumaNoGrupo ? '' : 'none';
    });

    const semResultado = document.getElementById('km-sem-resultado');
    if (semResultado) semResultado.style.display = (!algumaLinhaVisivel && veiculos.length) ? 'block' : 'none';
}

// ---------- validação de uma linha ----------
function validarLinha(idx) {
    const dataISO = dataParaISO(document.getElementById('km-data').value);
    if (!dataISO) return 'Informe a Data da Aferição no formato DD/MM/AAAA.';

    const responsavel = document.getElementById('km-responsavel').value.trim();
    if (!responsavel) return 'Informe o "Responsável pelas Informações" antes de enviar.';

    const tr = document.getElementById(linhaId(idx));
    const kmNoDia = tr.querySelector('.km-no-dia').value;
    if (kmNoDia === '' || !Number.isFinite(Number(kmNoDia)) || Number(kmNoDia) < 0) {
        return `Veículo ${veiculos[idx].placa}: informe um "Km no Dia" válido (número maior ou igual a zero).`;
    }

    const arquivos = fotosPorLinha[idx] || [];
    if (arquivos.length < MIN_FOTOS) return `Veículo ${veiculos[idx].placa}: anexe pelo menos 1 foto do veículo.`;
    if (arquivos.length > MAX_FOTOS) {
        return `Veículo ${veiculos[idx].placa}: no máximo ${MAX_FOTOS} fotos do veículo. Selecione todas de uma vez.`;
    }
    for (const arquivo of arquivos) {
        if (!['image/png', 'image/jpeg'].includes(arquivo.type)) {
            return `Veículo ${veiculos[idx].placa}: as fotos do veículo devem ser imagens JPG ou PNG.`;
        }
        if (arquivo.size > TAMANHO_MAX_FOTO) {
            return `Veículo ${veiculos[idx].placa}: uma das fotos passa de 10 MB. Envie imagens menores.`;
        }
    }
    return null;
}

function travarLinha(idx, enviada, rotulo) {
    const tr = document.getElementById(linhaId(idx));
    tr.querySelectorAll('input, textarea, button').forEach(el => { el.disabled = true; });
    const btn = tr.querySelector('.km-btn-linha');
    if (enviada) {
        btn.textContent = rotulo || '✓ Enviado';
        btn.classList.remove('btn-primary');
        btn.classList.add('btn-secondary');
        tr.classList.add('km-linha-enviada');
        if (!rotulo) limparErroLinha(idx); // envio desta sessão — some o aviso de pendência
        renderFotosLinha(idx); // tira os botões ✕ — não dá mais pra editar
    }
}

function destravarLinha(idx) {
    const tr = document.getElementById(linhaId(idx));
    tr.querySelectorAll('input, textarea, button').forEach(el => { el.disabled = false; });
    const btn = tr.querySelector('.km-btn-linha');
    btn.textContent = 'Enviar dados do veículo';
    btn.classList.remove('btn-secondary');
    btn.classList.add('btn-primary');
    tr.classList.remove('km-linha-enviada');
    renderFotosLinha(idx); // reacerta o estado do botão "Adicionar foto"
}

// Pergunta ao Supabase quais placas da lista já têm envio nesta data.
// Função SECURITY DEFINER (supabase/migracao-km-trava-envio-diario.sql) —
// devolve só as placas, sem dados pessoais. Falha de rede / função ainda
// não criada: devolve [] e o formulário segue sem as travas do servidor.
async function placasJaEnviadasNoDia(dataISO) {
    if (!dataISO || !veiculos.length) return [];
    try {
        const { data, error } = await supabaseClient.rpc('km_placas_enviadas', {
            p_data: dataISO,
            p_placas: veiculos.map(v => v.placa)
        });
        if (error) { console.warn('km_placas_enviadas:', error.message); return []; }
        return Array.isArray(data) ? data : [];
    } catch (e) {
        console.warn('km_placas_enviadas:', e.message);
        return [];
    }
}

// Trava (ou destrava, se a data mudou) os veículos que já têm envio hoje.
// Não mexe nas linhas já enviadas NESTA sessão.
async function sincronizarTravasDoDia() {
    const dataISO = dataParaISO(document.getElementById('km-data').value);
    const jaEnviadas = new Set(await placasJaEnviadasNoDia(dataISO));

    veiculos.forEach((v, idx) => {
        const enviadaNestaSessao = enviados[idx] && !travadosPorEnvioDoDia.has(idx);
        if (enviadaNestaSessao) return;

        const deveTravar = jaEnviadas.has(v.placa);
        if (deveTravar && !travadosPorEnvioDoDia.has(idx)) {
            travadosPorEnvioDoDia.add(idx);
            enviados[idx] = true;
            travarLinha(idx, true, '✓ Enviado hoje');
            mostrarInfoLinha(idx, 'Este veículo já teve os dados enviados hoje. Para corrigir, fale com a administração da campanha.');
        } else if (!deveTravar && travadosPorEnvioDoDia.has(idx)) {
            travadosPorEnvioDoDia.delete(idx);
            enviados[idx] = false;
            destravarLinha(idx);
            limparErroLinha(idx);
        }
    });
}

// Faz o upload da foto + o insert. Lança em caso de erro. Não mexe em UI.
async function persistirLinha(idx) {
    const v = veiculos[idx];
    const tr = document.getElementById(linhaId(idx));
    const dataISO = dataParaISO(document.getElementById('km-data').value);
    const responsavel = document.getElementById('km-responsavel').value.trim();
    const kmNoDia = Number(tr.querySelector('.km-no-dia').value);
    const observacoes = tr.querySelector('.km-obs').value.trim();
    const arquivos = (fotosPorLinha[idx] || []).slice(0, MAX_FOTOS);

    // As fotos entram na caixa de entrada com nome provisório; a
    // administração renomeia (FOTO_{PLACA}_CONTROLE_{DDMMAAAA}) ao aceitar.
    const placaSeg = sanitizarSegmentoCaminho(v.placa);
    const caminhosFotos = [];
    for (let i = 0; i < arquivos.length; i++) {
        const caminho = `km/${dataISO}/${placaSeg}_${Date.now()}_${i + 1}.${extensaoImagem(arquivos[i])}`;
        const { error: erroUpload } = await supabaseClient.storage
            .from('documentos-formularios').upload(caminho, arquivos[i]);
        if (erroUpload) throw new Error(`Falha ao enviar a foto ${i + 1} do veículo: ` + erroUpload.message);
        caminhosFotos.push(caminho);
    }

    const { error: erroInsert } = await supabaseClient.from('formularios_km').insert({
        data_afericao: dataISO,
        localidade: v.localidade === SEM_LOCALIDADE ? null : v.localidade,
        placa: v.placa,
        nome_proprietario: v.nome_proprietario || null,
        km_atual: (v.km_atual === null || v.km_atual === undefined) ? null : Number(v.km_atual),
        km_no_dia: kmNoDia,
        km_rodado: calcularKmRodado(v.km_atual, kmNoDia),
        veiculo_fotos_paths: caminhosFotos,
        observacoes: observacoes || null,
        responsavel_informacoes: responsavel,
        status: 'pendente'
    });
    if (erroInsert) throw new Error('Falha ao enviar os dados do veículo: ' + erroInsert.message);
}

// Garante que há um "Responsável pelas Informações" antes de enviar. Se o
// campo já tem valor, resolve na hora. Senão, abre o modal (pré-preenchido
// com o que estiver salvo no aparelho) e resolve true quando o usuário
// confirmar um nome, ou false se ele cancelar.
function garantirResponsavel() {
    const campo = document.getElementById('km-responsavel');
    if (campo.value.trim()) return Promise.resolve(true);

    const modal = document.getElementById('km-modal-responsavel');
    const input = document.getElementById('km-modal-responsavel-input');
    const erro = document.getElementById('km-modal-responsavel-erro');
    const btnOk = document.getElementById('km-modal-responsavel-confirmar');
    const btnCancelar = document.getElementById('km-modal-responsavel-cancelar');

    input.value = lerResponsavelSalvo();
    erro.style.display = 'none';
    modal.classList.add('show');
    setTimeout(() => input.focus(), 50);

    return new Promise(resolve => {
        function fechar(resultado) {
            modal.classList.remove('show');
            btnOk.removeEventListener('click', onOk);
            btnCancelar.removeEventListener('click', onCancelar);
            input.removeEventListener('keydown', onKey);
            modal.removeEventListener('click', onBackdrop);
            resolve(resultado);
        }
        function onOk() {
            const nome = input.value.trim();
            if (!nome) { erro.style.display = 'block'; input.focus(); return; }
            salvarResponsavel(nome);
            campo.value = nome;
            fechar(true);
        }
        function onCancelar() { fechar(false); }
        function onKey(e) {
            if (e.key === 'Enter') { e.preventDefault(); onOk(); }
            else if (e.key === 'Escape') { onCancelar(); }
        }
        function onBackdrop(e) { if (e.target === modal) onCancelar(); }
        btnOk.addEventListener('click', onOk);
        btnCancelar.addEventListener('click', onCancelar);
        input.addEventListener('keydown', onKey);
        modal.addEventListener('click', onBackdrop);
    });
}

async function enviarLinha(idx) {
    if (enviados[idx]) return;
    limparMensagem();
    limparErroLinha(idx);

    if (!(await garantirResponsavel())) return;

    const erro = validarLinha(idx);
    if (erro) { mostrarErroLinha(idx, erro); return; }

    const tr = document.getElementById(linhaId(idx));
    const btn = tr.querySelector('.km-btn-linha');
    tr.querySelectorAll('input, textarea, button').forEach(el => { el.disabled = true; });
    btn.textContent = 'Enviando…';

    try {
        await persistirLinha(idx);
        enviados[idx] = true;
        travarLinha(idx, true);
        mostrarSucessoLinha(idx, `Veículo ${veiculos[idx].placa}: dados enviados com sucesso.`);
        conferirSeTerminou();
    } catch (e) {
        destravarLinha(idx);
        mostrarErroLinha(idx, e.message || 'Não foi possível enviar. Verifique sua conexão e tente novamente.');
    }
}

// ---------- enviar todos ----------
async function enviarTodos() {
    limparMensagem();

    if (!(await garantirResponsavel())) return;

    document.getElementById('km-filtro-localidade').value = '';
    document.getElementById('km-filtro-placa').value = '';
    aplicarFiltros();

    const pendentes = veiculos.map((_, idx) => idx).filter(idx => !enviados[idx]);
    if (pendentes.length === 0) {
        mostrarMensagem('Todos os veículos já foram enviados.', 'info');
        return;
    }

    pendentes.forEach(limparErroLinha);
    const comErro = pendentes
        .map(idx => ({ idx, erro: validarLinha(idx) }))
        .filter(x => x.erro);
    if (comErro.length) {
        // Marca cada veículo pendente na sua própria linha e leva a vista
        // ao primeiro deles (sem pular pro rodapé).
        comErro.slice().reverse().forEach(x => mostrarErroLinha(x.idx, x.erro));
        return;
    }

    const btnTodos = document.getElementById('km-btn-enviar-todos');
    btnTodos.disabled = true;
    btnTodos.textContent = 'Enviando…';
    document.getElementById('km-data').disabled = true;
    document.getElementById('km-responsavel').disabled = true;

    let idxAtual = null;
    try {
        for (const idx of pendentes) {
            idxAtual = idx;
            const tr = document.getElementById(linhaId(idx));
            tr.querySelectorAll('input, textarea, button').forEach(el => { el.disabled = true; });
            tr.querySelector('.km-btn-linha').textContent = 'Enviando…';
            await persistirLinha(idx);
            enviados[idx] = true;
            travarLinha(idx, true);
        }
        conferirSeTerminou();
        if (!document.getElementById('fp-tela-sucesso').style.display.includes('block')) {
            mostrarMensagem('Dados enviados com sucesso.', 'sucesso');
        }
        btnTodos.textContent = 'Enviar informação de todos os veículos';
    } catch (e) {
        pendentes.forEach(idx => { if (!enviados[idx]) destravarLinha(idx); });
        document.getElementById('km-data').disabled = false;
        document.getElementById('km-responsavel').disabled = false;
        btnTodos.disabled = false;
        btnTodos.textContent = 'Enviar informação de todos os veículos';
        if (idxAtual !== null) {
            mostrarErroLinha(idxAtual, (e.message || 'Não foi possível concluir o envio.') + ' Este e os próximos continuam liberados para reenvio.');
        } else {
            mostrarMensagem(e.message || 'Não foi possível concluir o envio.', 'erro');
        }
    }
}

function conferirSeTerminou() {
    const todos = veiculos.length > 0 && veiculos.every((_, idx) => enviados[idx]);
    if (!todos) return;
    document.getElementById('fp-tela-formulario').style.display = 'none';
    document.getElementById('fp-tela-sucesso').style.display = 'block';
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function pararComErro(texto) {
    const el = document.getElementById('km-carregando');
    el.style.display = 'block';
    el.className = 'fp-msg erro';
    el.textContent = texto;
    document.getElementById('km-tabelas').innerHTML = '';
    document.getElementById('km-btn-enviar-todos').disabled = true;
    document.getElementById('km-filtro-localidade').disabled = true;
    document.getElementById('km-filtro-placa').disabled = true;
    const semResultado = document.getElementById('km-sem-resultado');
    if (semResultado) semResultado.style.display = 'none';
}

// Busca a definição da lista da equipe pelo slug da URL (?lista=<slug>).
// Devolve { nome, localidades } ou null se o slug não existir.
async function carregarListaPorSlug(slug) {
    const { data, error } = await supabaseClient
        .from('listas_km')
        .select('nome, localidades')
        .eq('slug', slug)
        .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    return {
        nome: data.nome,
        localidades: Array.isArray(data.localidades) ? data.localidades : []
    };
}

function mostrarNomeDaLista(nome) {
    const alvo = document.getElementById('km-lista-nome');
    if (!alvo) return;
    alvo.textContent = `Equipe: ${nome}`;
    alvo.style.display = 'inline-block';
}

// ---------- init ----------
async function carregar() {
    document.getElementById('km-data').value = hojeBR();
    document.getElementById('km-data').addEventListener('input', function () { this.value = mascararData(this.value); });
    document.getElementById('km-filtro-localidade').addEventListener('change', aplicarFiltros);
    document.getElementById('km-filtro-placa').addEventListener('input', aplicarFiltros);
    document.getElementById('km-btn-enviar-todos').addEventListener('click', enviarTodos);

    // Responsável pelas informações: vem preenchido com o que foi salvo
    // neste aparelho e regrava a cada digitação (editável a qualquer hora).
    const campoResp = document.getElementById('km-responsavel');
    const respSalvo = lerResponsavelSalvo();
    if (respSalvo) campoResp.value = respSalvo;
    campoResp.addEventListener('input', () => salvarResponsavel(campoResp.value));

    // O formulário SÓ funciona com um ?lista=<slug> válido — cada líder usa
    // o link da própria equipe. Sem isso (ou com slug inexistente), mostra
    // erro em vez de listar todos os veículos.
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

    let snap;
    try {
        const resp = await fetch('veiculos-snapshot.json', { cache: 'no-store' });
        if (!resp.ok) throw new Error(`status ${resp.status}`);
        snap = await resp.json();
        veiculos = Array.isArray(snap.veiculos) ? snap.veiculos : [];
    } catch (e) {
        pararComErro('Não foi possível carregar a lista de veículos. Recarregue a página ou fale com a administração da campanha.');
        return;
    }

    if (snapshotExpirado(snap.gerado_em)) {
        pararComErro('Este link expirou. A lista de veículos vale por 1 dia após ser publicada — peça um link atualizado à administração da campanha.');
        return;
    }

    veiculos = filtrarVeiculosPorLocalidades(veiculos, listaAtiva.localidades);
    if (veiculos.length === 0) {
        pararComErro('Nenhum veículo cadastrado nas regiões desta lista. Fale com a administração da campanha.');
        return;
    }

    document.getElementById('km-carregando').style.display = 'none';
    preencherFiltroLocalidades();
    renderTabelas();

    // Trava os veículos que já têm envio nesta data (checagem no Supabase).
    sincronizarTravasDoDia();
    let timerTravasData;
    document.getElementById('km-data').addEventListener('input', () => {
        clearTimeout(timerTravasData);
        timerTravasData = setTimeout(sincronizarTravasDoDia, 400);
    });
}

document.addEventListener('DOMContentLoaded', carregar);
