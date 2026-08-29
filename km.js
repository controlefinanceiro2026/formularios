// Formulário público de Controle de Km — hospedado no GitHub Pages, sem
// servidor próprio. Grava direto no Supabase (chave "anon public" — só
// INSERT, graças ao RLS de supabase/schema-formulario-km.sql). A lista de
// veículos vem de veiculos-snapshot.json, publicado pelo sistema local da
// campanha (Controle de Km → "Publicar lista para formulário público").
// O sistema local puxa esses envios periodicamente e os importa como
// leituras de odômetro.

const SEM_LOCALIDADE = 'Sem localidade definida';
const TAMANHO_MAX_FOTO = 10 * 1024 * 1024; // 10 MB

const supabaseClient = window.supabase.createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey);

// Estado por veículo (índice = posição no snapshot).
let veiculos = [];
const enviados = {}; // idx -> true depois de enviado com sucesso

// Lista por equipe ativa (quando a URL tem ?lista=<slug>): { nome, localidades }.
// Sem ?lista, o formulário mostra todos os veículos (uso do admin / link antigo).
let listaAtiva = null;

// Mesma regra de lib/kmFormulario.js#filtrarVeiculosPorLocalidades — aqui
// reimplementada porque o formulário público tem deploy isolado e não
// carrega aquele arquivo.
function filtrarVeiculosPorLocalidades(lista, localidades) {
    if (!localidades || !localidades.length) return lista.slice();
    const permitidas = new Set(localidades.map(l => String(l)));
    return lista.filter(v => permitidas.has(String(v.localidade)));
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

// ---------- render ----------
function linhaId(idx) { return `km-linha-${idx}`; }

function renderTabelas() {
    const container = document.getElementById('km-tabelas');
    const itens = veiculos.map((v, idx) => ({ veiculo: v, idx }));

    if (itens.length === 0) {
        container.innerHTML = '<div class="fp-msg info" style="display:block;">Nenhum veículo na lista publicada. Fale com a administração da campanha.</div>';
        return;
    }

    const grupos = agruparPorLocalidade(itens);
    container.innerHTML = grupos.map(g => `
        <div class="km-grupo" data-localidade="${encodeURIComponent(g.localidade)}">
            <div class="km-localidade-titulo">${g.localidade}</div>
            <div class="km-tabela-wrap">
                <table class="km-tabela">
                    <thead>
                        <tr>
                            <th>Placa</th><th>Proprietário</th><th>Km Atual</th>
                            <th>Km no Dia *</th><th>Km Rodado</th><th>Foto do Odômetro *</th><th></th>
                        </tr>
                    </thead>
                    <tbody>
                        ${g.itens.map(({ veiculo: v, idx }) => `
                            <tr id="${linhaId(idx)}" data-idx="${idx}">
                                <td><strong>${v.placa}</strong></td>
                                <td>${v.nome_proprietario || '—'}</td>
                                <td>${fmtKm(v.km_atual)}</td>
                                <td><input type="number" class="km-no-dia" min="0" step="1" placeholder="Ex: 45230"></td>
                                <td class="km-rodado">—</td>
                                <td>
                                    <input type="file" class="km-foto" accept="image/png,image/jpeg">
                                    <img class="km-foto-previa" alt="" style="display:none;">
                                </td>
                                <td><button type="button" class="btn-primary km-btn-linha" data-idx="${idx}">Enviar dados do veículo</button></td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        </div>
    `).join('');

    container.querySelectorAll('.km-no-dia').forEach(inp => inp.addEventListener('input', onKmNoDiaInput));
    container.querySelectorAll('.km-foto').forEach(inp => inp.addEventListener('change', onFotoChange));
    container.querySelectorAll('.km-btn-linha').forEach(btn => btn.addEventListener('click', () => enviarLinha(Number(btn.dataset.idx))));

    aplicarFiltroLocalidade();
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

function onFotoChange(e) {
    const tr = e.target.closest('tr');
    const img = tr.querySelector('.km-foto-previa');
    const arquivo = e.target.files[0];
    if (arquivo && arquivo.type.startsWith('image/')) {
        img.src = URL.createObjectURL(arquivo);
        img.style.display = 'block';
    } else {
        img.style.display = 'none';
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

function aplicarFiltroLocalidade() {
    const alvo = document.getElementById('km-filtro-localidade').value;
    document.querySelectorAll('.km-grupo').forEach(g => {
        const loc = decodeURIComponent(g.dataset.localidade);
        g.style.display = (!alvo || alvo === loc) ? '' : 'none';
    });
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

    const arquivo = tr.querySelector('.km-foto').files[0];
    if (!arquivo) return `Veículo ${veiculos[idx].placa}: anexe a foto do odômetro.`;
    if (!['image/png', 'image/jpeg'].includes(arquivo.type)) {
        return `Veículo ${veiculos[idx].placa}: a foto do odômetro deve ser uma imagem JPG ou PNG.`;
    }
    if (arquivo.size > TAMANHO_MAX_FOTO) {
        return `Veículo ${veiculos[idx].placa}: a foto do odômetro passa de 10 MB. Envie uma imagem menor.`;
    }
    return null;
}

function travarLinha(idx, enviada) {
    const tr = document.getElementById(linhaId(idx));
    tr.querySelectorAll('input, button').forEach(el => { el.disabled = true; });
    const btn = tr.querySelector('.km-btn-linha');
    if (enviada) {
        btn.textContent = '✓ Enviado';
        btn.classList.remove('btn-primary');
        btn.classList.add('btn-secondary');
        tr.classList.add('km-linha-enviada');
    }
}

function destravarLinha(idx) {
    const tr = document.getElementById(linhaId(idx));
    tr.querySelectorAll('input, button').forEach(el => { el.disabled = false; });
    tr.querySelector('.km-btn-linha').textContent = 'Enviar dados do veículo';
}

// Faz o upload da foto + o insert. Lança em caso de erro. Não mexe em UI.
async function persistirLinha(idx) {
    const v = veiculos[idx];
    const tr = document.getElementById(linhaId(idx));
    const dataISO = dataParaISO(document.getElementById('km-data').value);
    const responsavel = document.getElementById('km-responsavel').value.trim();
    const kmNoDia = Number(tr.querySelector('.km-no-dia').value);
    const arquivo = tr.querySelector('.km-foto').files[0];

    const caminhoFoto = `km/${dataISO}/${sanitizarSegmentoCaminho(v.placa)}_${Date.now()}.${extensaoImagem(arquivo)}`;
    const { error: erroUpload } = await supabaseClient.storage
        .from('documentos-formularios').upload(caminhoFoto, arquivo);
    if (erroUpload) throw new Error('Falha ao enviar a foto do odômetro: ' + erroUpload.message);

    const { error: erroInsert } = await supabaseClient.from('formularios_km').insert({
        data_afericao: dataISO,
        localidade: v.localidade === SEM_LOCALIDADE ? null : v.localidade,
        placa: v.placa,
        nome_proprietario: v.nome_proprietario || null,
        km_atual: (v.km_atual === null || v.km_atual === undefined) ? null : Number(v.km_atual),
        km_no_dia: kmNoDia,
        km_rodado: calcularKmRodado(v.km_atual, kmNoDia),
        odometro_foto_path: caminhoFoto,
        responsavel_informacoes: responsavel,
        status: 'pendente'
    });
    if (erroInsert) throw new Error('Falha ao enviar os dados do veículo: ' + erroInsert.message);
}

async function enviarLinha(idx) {
    if (enviados[idx]) return;
    limparMensagem();

    const erro = validarLinha(idx);
    if (erro) { mostrarMensagem(erro, 'erro'); return; }

    const tr = document.getElementById(linhaId(idx));
    const btn = tr.querySelector('.km-btn-linha');
    tr.querySelectorAll('input, button').forEach(el => { el.disabled = true; });
    btn.textContent = 'Enviando…';

    try {
        await persistirLinha(idx);
        enviados[idx] = true;
        travarLinha(idx, true);
        mostrarMensagem(`Veículo ${veiculos[idx].placa}: dados enviados com sucesso.`, 'sucesso');
        conferirSeTerminou();
    } catch (e) {
        destravarLinha(idx);
        mostrarMensagem(e.message || 'Não foi possível enviar. Verifique sua conexão e tente novamente.', 'erro');
    }
}

// ---------- enviar todos ----------
async function enviarTodos() {
    limparMensagem();
    document.getElementById('km-filtro-localidade').value = '';
    aplicarFiltroLocalidade();

    const pendentes = veiculos.map((_, idx) => idx).filter(idx => !enviados[idx]);
    if (pendentes.length === 0) {
        mostrarMensagem('Todos os veículos já foram enviados.', 'info');
        return;
    }

    for (const idx of pendentes) {
        const erro = validarLinha(idx);
        if (erro) { mostrarMensagem('Antes de enviar todos: ' + erro, 'erro'); return; }
    }

    const btnTodos = document.getElementById('km-btn-enviar-todos');
    btnTodos.disabled = true;
    btnTodos.textContent = 'Enviando…';
    document.getElementById('km-data').disabled = true;
    document.getElementById('km-responsavel').disabled = true;

    try {
        for (const idx of pendentes) {
            const tr = document.getElementById(linhaId(idx));
            tr.querySelectorAll('input, button').forEach(el => { el.disabled = true; });
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
        mostrarMensagem((e.message || 'Não foi possível concluir o envio.') + ' Os veículos que faltam continuam liberados para reenvio.', 'erro');
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
    document.getElementById('km-filtro-localidade').addEventListener('change', aplicarFiltroLocalidade);
    document.getElementById('km-btn-enviar-todos').addEventListener('click', enviarTodos);

    const slugLista = new URLSearchParams(location.search).get('lista');

    if (slugLista) {
        try {
            listaAtiva = await carregarListaPorSlug(slugLista.trim());
        } catch (e) {
            pararComErro('Não foi possível carregar a lista desta equipe. Recarregue a página ou confirme o link com a administração da campanha.');
            return;
        }
        if (!listaAtiva) {
            pararComErro('Lista não encontrada. Confirme o link recebido com a administração da campanha.');
            return;
        }
        mostrarNomeDaLista(listaAtiva.nome);
    }

    try {
        const resp = await fetch('veiculos-snapshot.json', { cache: 'no-store' });
        if (!resp.ok) throw new Error(`status ${resp.status}`);
        const snap = await resp.json();
        veiculos = Array.isArray(snap.veiculos) ? snap.veiculos : [];
    } catch (e) {
        pararComErro('Não foi possível carregar a lista de veículos. Recarregue a página ou fale com a administração da campanha.');
        return;
    }

    if (listaAtiva) {
        veiculos = filtrarVeiculosPorLocalidades(veiculos, listaAtiva.localidades);
        if (veiculos.length === 0) {
            pararComErro('Nenhum veículo cadastrado nas regiões desta lista. Fale com a administração da campanha.');
            return;
        }
    }

    document.getElementById('km-carregando').style.display = 'none';
    if (veiculos.length === 0) {
        document.getElementById('km-btn-enviar-todos').disabled = true;
        document.getElementById('km-filtro-localidade').disabled = true;
    }
    preencherFiltroLocalidades();
    renderTabelas();
}

document.addEventListener('DOMContentLoaded', carregar);
