// Formulário público de pré-cadastro de pessoal — hospedado no GitHub
// Pages, sem servidor próprio. Grava direto no Supabase (chave "anon
// public" — só consegue INSERIR, nunca ler/editar/apagar, graças às
// políticas de Row Level Security definidas em
// supabase/schema-formulario-pessoal.sql). O sistema local da campanha
// puxa essas submissões periodicamente, nunca ficando exposto à internet.

// Regiões de fiscalização da campanha (ver Regiões.jpeg) — mesma estrutura
// de lib/regioesDF.js e app.js; mantenha as três em sincronia. O dropdown
// "Local da Prestação do Serviço" agrupa as localidades por região.
const REGIOES_FISCALIZACAO = {
    'Comitê': ['Comitê'],
    'Região Sul': ['Santa Maria', 'Gama', 'Riacho Fundo I', 'Riacho Fundo II', 'Recanto das Emas', 'Samambaia'],
    'Região Leste': ['Taguatinga', 'Arniqueira', 'Águas Claras', 'Sol Nascente / Pôr do Sol', 'Ceilândia', 'Brazlândia'],
    'Região Norte': ['Planaltina', 'Sobradinho', 'Paranoá', 'Itapoã', 'São Sebastião', 'Jardim Botânico'],
    'Região Centrinho': ['Plano Piloto', 'SIA', 'Guará', 'Núcleo Bandeirante', 'Candangolândia', 'Estrutural', 'Vicente Pires', 'Cruzeiro', 'Lago Sul', 'Lago Norte', 'Sudoeste/Octogonal', 'Park Way', 'Varjão']
};
const LOCAIS_PRESTACAO_SERVICO = Object.keys(REGIOES_FISCALIZACAO)
    .reduce((acc, r) => acc.concat(REGIOES_FISCALIZACAO[r]), []);

const supabaseClient = window.supabase.createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey);

function mascararCPF(valor) {
    return String(valor || '')
        .replace(/\D/g, '')
        .slice(0, 11)
        .replace(/(\d{3})(\d)/, '$1.$2')
        .replace(/(\d{3})(\d)/, '$1.$2')
        .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
}

function mascararTelefone(valor) {
    const digitos = String(valor || '').replace(/\D/g, '').slice(0, 11);
    if (digitos.length <= 10) {
        return digitos.replace(/(\d{2})(\d)/, '($1) $2').replace(/(\d{4})(\d{1,4})$/, '$1-$2');
    }
    return digitos.replace(/(\d{2})(\d)/, '($1) $2').replace(/(\d{5})(\d{1,4})$/, '$1-$2');
}

function mascararCEP(valor) {
    return String(valor || '').replace(/\D/g, '').slice(0, 8).replace(/(\d{5})(\d{1,3})$/, '$1-$2');
}

function mascararCNPJ(valor) {
    return String(valor || '')
        .replace(/\D/g, '')
        .slice(0, 14)
        .replace(/(\d{2})(\d)/, '$1.$2')
        .replace(/(\d{3})(\d)/, '$1.$2')
        .replace(/(\d{3})(\d)/, '$1/$2')
        .replace(/(\d{4})(\d{1,2})$/, '$1-$2');
}

// Máscara AAAA — só 4 dígitos numéricos, sem separadores.
function mascararAno(valor) {
    return String(valor || '').replace(/\D/g, '').slice(0, 4);
}

// Máscara de placa — 7 caracteres, sem separadores, maiúsculas. Aceita
// padrão antigo (AAA9999) e Mercosul (AAA9A99), enforçando letra/dígito
// por posição.
function mascararPlaca(valor) {
    const bruto = String(valor || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 7);
    let saida = '';
    for (let i = 0; i < bruto.length; i++) {
        const c = bruto[i];
        const ehLetra = c >= 'A' && c <= 'Z';
        const ehDigito = c >= '0' && c <= '9';
        const posicaoOk = i < 3 ? ehLetra : (i === 4 ? (ehLetra || ehDigito) : ehDigito);
        if (!posicaoOk) break;
        saida += c;
    }
    return saida;
}

const ANO_VEICULO_PROIBIDO = '2026';

// Além de barrar no envio, avisa já no campo que o Ano do Veículo não pode
// ser o ano proibido (2026).
function validarAnoVeiculo() {
    const input = document.getElementById('fv-ano');
    const erroEl = document.getElementById('fv-ano-erro');
    const valor = input.value;

    if (valor === ANO_VEICULO_PROIBIDO) {
        erroEl.textContent = `Veículos do ano ${ANO_VEICULO_PROIBIDO} não podem ser cadastrados.`;
        erroEl.style.display = 'block';
        return false;
    }
    erroEl.style.display = 'none';
    erroEl.textContent = '';
    return true;
}

// A seção de veículo só aparece pra quem se declara Líder — o líder é o
// proprietário do veículo cedido à campanha (ver lib/regioesDF.js /
// veiculos.lider_id no app admin).
function ehLider() {
    return document.getElementById('fp-funcao').value === 'lider';
}

function atualizarVisibilidadeVeiculo() {
    const mostrar = ehLider();
    document.getElementById('fp-secao-veiculo').style.display = mostrar ? 'block' : 'none';
    document.getElementById('fp-doc-veiculo-grupo').style.display = mostrar ? 'block' : 'none';
    ['fv-placa', 'fv-marca', 'fv-modelo', 'fv-cnpj', 'fv-ano', 'fv-doc-veiculo'].forEach(id => {
        document.getElementById(id).required = mostrar;
    });
}

function preencherLocais() {
    const selectLocal = document.getElementById('fp-local-prestacao');
    Object.keys(REGIOES_FISCALIZACAO).forEach(regiao => {
        const grupo = document.createElement('optgroup');
        grupo.label = regiao;
        REGIOES_FISCALIZACAO[regiao].forEach(local => {
            const opt = document.createElement('option');
            opt.value = local; opt.textContent = local;
            grupo.appendChild(opt);
        });
        selectLocal.appendChild(grupo);
    });
}

function mostrarMensagem(texto, tipo) {
    const el = document.getElementById('fp-mensagem');
    el.textContent = texto;
    el.className = `fp-msg ${tipo}`;
}

// Usado só pra montar a pasta do documento (nome digitado vira parte de um
// caminho de Storage) — troca "/" por "-" pra nunca criar um nível de pasta
// indesejado a partir de um nome com barra.
function sanitizarSegmentoCaminho(valor) {
    return String(valor || '')
        .normalize('NFD').replace(/\p{Diacritic}/gu, '')
        .trim().replace(/[\/\\]+/g, '-') || 'sem-nome';
}

async function enviarFormulario(e) {
    e.preventDefault();

    const arquivoCpf = document.getElementById('fp-doc-cpf').files[0];
    const arquivoComprovante = document.getElementById('fp-doc-comprovante').files[0];
    if (!arquivoCpf || !arquivoComprovante) {
        mostrarMensagem('Anexe a documentação (CPF e comprovante de residência) antes de enviar.', 'erro');
        return;
    }

    const lider = ehLider();
    let arquivoVeiculo = null;
    if (lider) {
        if (!document.getElementById('fv-placa').value.trim()) {
            mostrarMensagem('Informe a placa do veículo.', 'erro');
            return;
        }
        if (!document.getElementById('fv-cnpj').value.replace(/\D/g, '')) {
            mostrarMensagem('Informe o CNPJ associado ao veículo.', 'erro');
            return;
        }
        if (!validarAnoVeiculo()) {
            mostrarMensagem(`Veículos do ano ${ANO_VEICULO_PROIBIDO} não podem ser cadastrados. Corrija o campo "Ano do Veículo" antes de enviar.`, 'erro');
            return;
        }
        if (document.getElementById('fv-ano').value.length !== 4) {
            mostrarMensagem('Informe o ano do veículo com 4 dígitos (ex: 2019).', 'erro');
            return;
        }
        arquivoVeiculo = document.getElementById('fv-doc-veiculo').files[0];
        if (!arquivoVeiculo) {
            mostrarMensagem('Anexe o documento do veículo (CRLV) antes de enviar.', 'erro');
            return;
        }
    }

    if (!document.getElementById('fp-lgpd-aceite').checked) {
        mostrarMensagem('É necessário concordar com os termos da LGPD para enviar o formulário.', 'erro');
        return;
    }

    const cpfDigitos = document.getElementById('fp-cpf').value.replace(/\D/g, '');
    if (cpfDigitos.length !== 11) {
        mostrarMensagem('CPF inválido — informe os 11 dígitos.', 'erro');
        return;
    }

    const botao = document.getElementById('fp-btn-enviar');
    botao.disabled = true;
    botao.textContent = 'Enviando...';

    try {
        // Pasta = pessoal/{nome da pessoa}; arquivo = "CPF" / "Comprovante_
        // Residencia" + timestamp (garante caminho novo a cada envio — sem
        // upsert, que exigiria SELECT de "anon" no bucket e deixaria os
        // documentos de qualquer pessoa legíveis por qualquer um que
        // soubesse o nome dela).
        const agora = Date.now();
        const nomeSanitizado = sanitizarSegmentoCaminho(document.getElementById('fp-nome').value);
        const extCpf = arquivoCpf.name.split('.').pop();
        const extComprovante = arquivoComprovante.name.split('.').pop();
        const caminhoDocCpf = `pessoal/${nomeSanitizado}/CPF_${agora}.${extCpf}`;
        const caminhoComprovante = `pessoal/${nomeSanitizado}/Comprovante_Residencia_${agora}.${extComprovante}`;

        const { error: erroUploadCpf } = await supabaseClient.storage
            .from('documentos-formularios').upload(caminhoDocCpf, arquivoCpf);
        if (erroUploadCpf) throw new Error('Falha ao enviar o documento de CPF: ' + erroUploadCpf.message);

        const { error: erroUploadComprovante } = await supabaseClient.storage
            .from('documentos-formularios').upload(caminhoComprovante, arquivoComprovante);
        if (erroUploadComprovante) throw new Error('Falha ao enviar o comprovante de residência: ' + erroUploadComprovante.message);

        // O veículo (quando líder) é inserido antes do formulário de pessoal:
        // as duas tabelas são independentes (sem FK), então cadastrar o
        // veículo primeiro evita deixar uma pré-inscrição de Pessoal órfã
        // caso o envio do veículo falhe.
        if (lider) {
            const extVeiculo = arquivoVeiculo.name.split('.').pop();
            const caminhoVeiculo = `veiculo/${nomeSanitizado}/CRLV_${agora}.${extVeiculo}`;

            const { error: erroUploadVeiculo } = await supabaseClient.storage
                .from('documentos-formularios').upload(caminhoVeiculo, arquivoVeiculo);
            if (erroUploadVeiculo) throw new Error('Falha ao enviar o documento do veículo: ' + erroUploadVeiculo.message);

            const { error: erroInsertVeiculo } = await supabaseClient.from('formularios_veiculo').insert({
                placa: mascararPlaca(document.getElementById('fv-placa').value),
                marca: document.getElementById('fv-marca').value.trim() || null,
                modelo: document.getElementById('fv-modelo').value.trim() || null,
                ano_fabricacao: document.getElementById('fv-ano').value || null,
                nome_proprietario: document.getElementById('fp-nome').value,
                cpf_proprietario: cpfDigitos,
                cnpj_associado: document.getElementById('fv-cnpj').value,
                documento_veiculo_path: caminhoVeiculo,
                status: 'pendente'
            });
            if (erroInsertVeiculo) throw new Error('Falha ao enviar os dados do veículo: ' + erroInsertVeiculo.message);
        }

        const { error: erroInsert } = await supabaseClient.from('formularios_pessoal').insert({
            nome: document.getElementById('fp-nome').value,
            cpf: cpfDigitos,
            endereco: document.getElementById('fp-endereco').value,
            telefone: document.getElementById('fp-telefone').value,
            cep: document.getElementById('fp-cep').value,
            funcao: document.getElementById('fp-funcao').value,
            local_prestacao: document.getElementById('fp-local-prestacao').value,
            documento_cpf_path: caminhoDocCpf,
            comprovante_residencia_path: caminhoComprovante,
            lgpd_aceite: true,
            status: 'pendente'
        });
        if (erroInsert) throw new Error('Falha ao enviar o formulário: ' + erroInsert.message);

        document.getElementById('fp-tela-formulario').style.display = 'none';
        document.getElementById('fp-tela-sucesso').style.display = 'block';
    } catch (erro) {
        mostrarMensagem(erro.message || 'Não foi possível enviar o formulário. Verifique sua conexão e tente novamente.', 'erro');
        botao.disabled = false;
        botao.textContent = 'Enviar Formulário';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    preencherLocais();
    document.getElementById('fp-cpf').addEventListener('input', function () { this.value = mascararCPF(this.value); });
    document.getElementById('fp-telefone').addEventListener('input', function () { this.value = mascararTelefone(this.value); });
    document.getElementById('fp-cep').addEventListener('input', function () { this.value = mascararCEP(this.value); });
    document.getElementById('fp-funcao').addEventListener('change', atualizarVisibilidadeVeiculo);
    document.getElementById('fv-placa').addEventListener('input', function () { this.value = mascararPlaca(this.value); });
    document.getElementById('fv-cnpj').addEventListener('input', function () { this.value = mascararCNPJ(this.value); });
    document.getElementById('fv-ano').addEventListener('input', function () {
        this.value = mascararAno(this.value);
        if (this.value.length === 4) validarAnoVeiculo();
        else document.getElementById('fv-ano-erro').style.display = 'none';
    });
    document.getElementById('fv-ano').addEventListener('blur', validarAnoVeiculo);
    document.getElementById('form-pre-cadastro').addEventListener('submit', enviarFormulario);
});
