// Geração de Contrato de Prestação de Serviços e Termo de Cessão de
// Veículo — versão client-side (jsPDF) do painel-consulta, já que este
// site é 100% estático (sem servidor próprio, ao contrário da plataforma
// principal). O TEXTO das cláusulas é uma cópia fiel de lib/pdfContrato.js
// e lib/pdfTermoCessao.js (pdfkit, servidor) — se o modelo oficial mudar
// lá, replique a mudança aqui também.

const CONTRATANTE = {
    nome: 'Eleições 2026 CHRISTIANNO NOGUEIRA ARAÚJO — DEPUTADO DISTRITAL',
    cnpj: '68.430.957/0001-01',
    administrador: 'DELCIMAR DE OLIVEIRA SILVA',
    cpfAdministrador: '584.477.501-59'
};

const ROTULOS_PERIODICIDADE = {
    semanal: 'semanalmente',
    quinzenal: 'quinzenalmente',
    fixo: 'nas datas definidas no cronograma de pagamento da campanha',
    personalizado: 'nas datas definidas no cronograma de pagamento da campanha'
};

const FIM_CESSAO_TEXTO = '03 de outubro de 2026';

function formatarDataBR(dataString) {
    if (!dataString) return null;
    const data = new Date(dataString);
    data.setMinutes(data.getMinutes() + data.getTimezoneOffset());
    return data.toLocaleDateString('pt-BR');
}

function formatarMoedaPdf(valor) {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(valor);
}

// Pequeno wrapper sobre o jsPDF pra escrever em fluxo (texto que quebra
// linha e empurra o cursor Y sozinho, com salto de página automático) —
// mesmo espírito do pdfkit usado no servidor, só que sem a dependência.
function criarEscritorPdf() {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const margem = 60;
    const larguraPagina = doc.internal.pageSize.getWidth();
    const alturaPagina = doc.internal.pageSize.getHeight();
    const larguraUtil = larguraPagina - margem * 2;
    let y = margem;

    function novaPaginaSeNecessario(altura) {
        if (y + altura > alturaPagina - margem) {
            doc.addPage();
            y = margem;
        }
    }

    function texto(str, { tamanho = 10, negrito = false, centro = false, justificar = false, alturaLinha = 13 } = {}) {
        doc.setFont('helvetica', negrito ? 'bold' : 'normal');
        doc.setFontSize(tamanho);
        const linhas = doc.splitTextToSize(str, larguraUtil);
        linhas.forEach(linha => {
            novaPaginaSeNecessario(alturaLinha);
            const opcoes = {};
            let x = margem;
            if (centro) { x = margem + larguraUtil / 2; opcoes.align = 'center'; }
            else if (justificar) { opcoes.maxWidth = larguraUtil; opcoes.align = 'justify'; }
            doc.text(linha, x, y, opcoes);
            y += alturaLinha;
        });
    }

    function linhaRotulo(rotulo, valor) {
        novaPaginaSeNecessario(13);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        const prefixo = `${rotulo}: `;
        doc.text(prefixo, margem, y);
        const largPrefixo = doc.getTextWidth(prefixo);
        doc.setFont('helvetica', 'normal');
        doc.text(String(valor == null || valor === '' ? '-' : valor), margem + largPrefixo, y);
        y += 13;
    }

    function moveDown(pontos = 13) {
        y += pontos;
        novaPaginaSeNecessario(0);
    }

    return { doc, texto, linhaRotulo, moveDown };
}

// Contrato de Prestação de Serviços — mesmo texto de lib/pdfContrato.js.
function gerarPdfContrato(pessoa) {
    const w = criarEscritorPdf();

    w.texto('CONTRATO DE PRESTAÇÃO DE SERVIÇOS TEMPORÁRIOS', { tamanho: 14, negrito: true, centro: true, alturaLinha: 18 });
    w.texto('CAMPANHA ELEITORAL — ELEIÇÕES 2026', { tamanho: 12, centro: true, alturaLinha: 16 });
    w.moveDown(13);

    w.texto(
        `Pelo presente instrumento particular, de um lado, ${CONTRATANTE.nome}, inscrito no CNPJ sob nº ` +
        `${CONTRATANTE.cnpj}, neste ato representado por seu Administrador Financeiro, Sr. ${CONTRATANTE.administrador}, ` +
        `portador do CPF nº ${CONTRATANTE.cpfAdministrador}, doravante denominado CONTRATANTE, e de outro lado, ` +
        'doravante denominado CONTRATADO(A), assim qualificado(a):',
        { justificar: true }
    );
    w.moveDown(10);

    const ehFiscalizacao = pessoa.funcao === 'fiscalizacao';
    w.linhaRotulo('Nome', pessoa.nome);
    w.linhaRotulo('CPF', pessoa.cpf);
    if (!ehFiscalizacao) {
        w.linhaRotulo('PIX (obrigatoriamente o CPF do próprio Contratado)', pessoa.chave_pix || pessoa.cpf);
        w.linhaRotulo('Endereço', pessoa.endereco);
        w.linhaRotulo('CEP', pessoa.cep);
    }
    w.moveDown(13);

    w.texto('CLÁUSULA PRIMEIRA — DO OBJETO', { negrito: true });
    if (ehFiscalizacao) {
        w.texto(
            `O(A) Contratado(a) prestará os serviços de ${pessoa.descricao_atividades || 'fiscalização de campanha'}, ` +
            'acompanhando a regularidade da propaganda eleitoral e das atividades da Campanha do CANDIDATO, ' +
            'durante as eleições de 2026.',
            { justificar: true }
        );
    } else {
        w.texto(
            `O(A) Contratado(a) prestará os serviços de ${pessoa.descricao_atividades || 'mobilização de rua'}, ` +
            'para divulgação da propaganda eleitoral e apoio à Campanha do CANDIDATO, durante as eleições de 2026 ' +
            `em ${pessoa.local_prestacao || 'Brasília, DF'}.`,
            { justificar: true }
        );
    }
    w.moveDown(5);
    w.texto(
        'Parágrafo Primeiro. Este contrato, para prestação de serviços temporários na campanha eleitoral, ' +
        'eleições de 2026, não gera vínculo empregatício com o Candidato, nos termos do art. 100 da Lei nº 9.504/1997.',
        { tamanho: 9, justificar: true, alturaLinha: 12 }
    );
    w.moveDown(10);

    w.texto('CLÁUSULA SEGUNDA — DO PRAZO DE VIGÊNCIA', { negrito: true });
    const inicio = formatarDataBR(pessoa.data_inicio);
    const fim = formatarDataBR(pessoa.data_fim);
    w.texto(
        `O presente contrato terá início na data de ${inicio || 'sua assinatura'} e vigorará até o dia ` +
        `${fim || '03 de outubro de 2026'}.`,
        { justificar: true }
    );
    w.moveDown(10);

    w.texto('CLÁUSULA TERCEIRA — DOS PREÇOS DOS SERVIÇOS E FORMA DE PAGAMENTO', { negrito: true });
    const valorFormatado = typeof pessoa.valor_contrato === 'number' && pessoa.valor_contrato > 0
        ? formatarMoedaPdf(pessoa.valor_contrato)
        : 'R$ _____________________';
    const periodicidade = ROTULOS_PERIODICIDADE[pessoa.periodicidade_pagamento] || 'quinzenalmente';
    w.texto(
        ehFiscalizacao
            ? `O CONTRATANTE pagará ao(à) CONTRATADO(A) o valor de ${valorFormatado}.`
            : `O CONTRATANTE pagará ao(à) CONTRATADO(A) o valor de ${valorFormatado}, sendo o pagamento realizado ${periodicidade}.`,
        { justificar: true }
    );
    w.moveDown(13);

    w.texto(
        'Fica eleito o foro de Brasília, DF, para dirimir questões decorrentes deste contrato. E, assim, ' +
        'as partes assinam o presente.',
        { justificar: true }
    );
    w.moveDown(7);
    w.texto(`Brasília, DF, ${new Date().toLocaleDateString('pt-BR')}`);
    w.moveDown(39);

    w.texto('_________________________________________');
    w.texto('CONTRATADO(A)', { negrito: true });
    w.texto(pessoa.nome || '');
    w.moveDown(32);

    w.texto('_________________________________________');
    w.texto('ELEIÇÃO 2026', { negrito: true });
    w.texto('CHRISTIANNO NOGUEIRA ARAÚJO');
    w.texto('DEPUTADO DISTRITAL');

    return w.doc;
}

// Termo de Cessão de Veículo — mesmo texto de lib/pdfTermoCessao.js.
function gerarPdfTermoCessao(veiculo) {
    const w = criarEscritorPdf();

    w.texto('TERMO DE CESSÃO DE VEÍCULO', { tamanho: 14, negrito: true, centro: true, alturaLinha: 18 });
    w.texto('ESTIMÁVEL EM DINHEIRO — CAMPANHA ELEITORAL 2026', { tamanho: 12, centro: true, alturaLinha: 16 });
    w.moveDown(13);

    w.texto(
        `Pelo presente termo de cessão de veículo, estimável em dinheiro, de um lado ${CONTRATANTE.nome}, ` +
        `inscrito no CNPJ sob nº ${CONTRATANTE.cnpj}, neste ato representado por seu Administrador Financeiro, ` +
        `Sr. ${CONTRATANTE.administrador}, portador do CPF nº ${CONTRATANTE.cpfAdministrador}, doravante ` +
        'denominado CESSIONÁRIO, e de outro lado, doravante denominado(a) CEDENTE, assim qualificado(a):',
        { justificar: true }
    );
    w.moveDown(10);

    w.linhaRotulo('Nome', veiculo.nome_proprietario);
    w.linhaRotulo('CPF', veiculo.cpf_proprietario);
    w.moveDown(13);

    w.texto('CLÁUSULA PRIMEIRA — DO OBJETO', { negrito: true });
    w.texto(
        'O(A) CEDENTE cede ao CESSIONÁRIO, a título gratuito, o veículo de sua propriedade, conforme CRLV ' +
        'em anexo, abaixo identificado, incluindo o motorista, para uso na campanha eleitoral de 2026:',
        { justificar: true }
    );
    w.moveDown(5);
    w.linhaRotulo('Marca', veiculo.marca);
    w.linhaRotulo('Modelo', veiculo.modelo);
    w.linhaRotulo('Ano de fabricação', veiculo.ano_fabricacao);
    w.linhaRotulo('Placa', veiculo.placa);
    w.moveDown(10);

    w.texto('CLÁUSULA SEGUNDA — DO PRAZO DE CESSÃO', { negrito: true });
    const inicio = formatarDataBR(veiculo.data_inicio_cessao);
    w.texto(
        `O veículo será cedido no período de ${inicio || 'sua validação'} até o dia ${FIM_CESSAO_TEXTO}.`,
        { justificar: true }
    );
    w.moveDown(10);

    w.texto('CLÁUSULA TERCEIRA — DO VALOR ESTIMADO', { negrito: true });
    const valorFormatado = typeof veiculo.valor_contratado === 'number' && veiculo.valor_contratado > 0
        ? formatarMoedaPdf(veiculo.valor_contratado)
        : 'R$ _____________________';
    w.texto(
        'A presente cessão é estimada em dinheiro pelo valor de mercado abaixo indicado, avaliado conforme ' +
        'o recibo eleitoral também identificado:',
        { justificar: true }
    );
    w.moveDown(5);
    w.linhaRotulo('Valor estimado (R$)', valorFormatado);
    w.linhaRotulo('Nº do recibo eleitoral', null);
    w.linhaRotulo('Data do recibo', null);
    w.moveDown(10);

    w.texto('CLÁUSULA QUARTA — DAS DESPESAS', { negrito: true });
    w.texto(
        'Todas as despesas que por ventura surgirem com o veículo cedido correrão por conta do CESSIONÁRIO.',
        { justificar: true }
    );
    w.moveDown(13);

    w.texto('Por ser verdade, assinam o presente termo.', { justificar: true });
    w.moveDown(7);
    w.texto(`Brasília, DF, ${inicio || new Date().toLocaleDateString('pt-BR')}`);
    w.moveDown(39);

    w.texto('_________________________________________');
    w.texto('CEDENTE', { negrito: true });
    w.texto(veiculo.nome_proprietario || '');
    w.moveDown(32);

    w.texto('_________________________________________');
    w.texto('ELEIÇÃO 2026', { negrito: true });
    w.texto('CHRISTIANNO NOGUEIRA ARAÚJO');
    w.texto('DEPUTADO DISTRITAL');
    w.texto('CESSIONÁRIO', { negrito: true });

    return w.doc;
}

function abrirPdfEmNovaAba(doc) {
    const blobUrl = doc.output('bloburl');
    window.open(blobUrl, '_blank');
}
