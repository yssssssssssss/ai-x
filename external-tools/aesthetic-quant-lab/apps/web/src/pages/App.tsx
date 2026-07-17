import { UploadOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Col,
  ConfigProvider,
  Descriptions,
  Empty,
  Layout,
  List,
  Menu,
  Row,
  Space,
  Statistic,
  Tag,
  Typography,
} from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { useRef, useState } from 'react';
import type { AestheticAnalyzeResult, UploadedImageRef } from '@aesthetic-quant-lab/core';
import { analyze, uploadImage } from '../lib/api.js';
import './styles.css';

const { Header, Sider, Content } = Layout;
const { Title, Paragraph, Text } = Typography;

const dimLabels: Array<{ key: keyof AestheticAnalyzeResult['dimensionScores']; label: string }> = [
  { key: 'overallColorScore', label: '整体色彩' },
  { key: 'temperatureScore', label: '色温' },
  { key: 'colorfulnessScore', label: '色彩丰富度' },
  { key: 'harmonyScore', label: '和谐度' },
  { key: 'attentionFocusScore', label: '注意力聚焦' },
];

const confidenceColor: Record<string, string> = { high: 'green', medium: 'orange', low: 'red' };

export const App = () => {
  const [designImage, setDesignImage] = useState<UploadedImageRef>();
  const [preview, setPreview] = useState<string>();
  const [result, setResult] = useState<AestheticAnalyzeResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    setError(undefined);
    try {
      setPreview(URL.createObjectURL(file));
      setDesignImage(await uploadImage(file));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setResult(
        await analyze({
          designImage,
          profileId: 'balanced',
          depth: 'standard',
          rois: [
            { id: 'hero', label: '主视觉区域', x: 0.12, y: 0.12, width: 0.52, height: 0.38 },
            { id: 'action', label: '行动区域', x: 0.58, y: 0.62, width: 0.3, height: 0.22 },
          ],
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const dims = result?.dimensionScores;
  const whole = result?.wholeImage;
  const pair = result?.pairResult;
  const attn = result?.attentionResult;

  return (
    <ConfigProvider locale={zhCN} theme={{ token: { borderRadius: 14, colorPrimary: '#d46b08' } }}>
      <Layout className="app-shell">
        <Sider width={240} theme="light" className="app-shell-sider">
          <div className="app-shell-brand">
            <div className="app-shell-brand-kicker">Research OS</div>
            <div className="app-shell-brand-title">AI 用研分析系统</div>
          </div>
          <Menu
            selectedKeys={['aesthetic']}
            mode="inline"
            items={[{ key: 'aesthetic', label: '美学量化分析' }]}
          />
        </Sider>
        <Layout className="app-shell-main">
          <Header className="app-shell-header">
            <div className="app-shell-header-kicker">Workspace</div>
            <div className="app-shell-header-title">美学量化分析</div>
            <div className="app-shell-header-subtitle">
              上传设计图，输出美学量化、ROI、启发式注意力与优化建议
            </div>
          </Header>
          <Content className="app-shell-content">
            <div className="app-shell-content-inner">
              {/* ---------- 操作区 ---------- */}
              <Card className="page-card" title="发起分析">
                <Space direction="vertical" size={18} style={{ width: '100%' }}>
                  <div className="lab-uploader">
                    <Text type="secondary" style={{ fontWeight: 600 }}>设计图 *</Text>
                    {preview ? (
                      <img className="lab-uploader-preview" src={preview} alt="设计图预览" />
                    ) : null}
                    <div>
                      <Button icon={<UploadOutlined />} onClick={() => fileRef.current?.click()}>
                        上传设计图
                      </Button>
                      {designImage ? (
                        <Text type="secondary" style={{ marginLeft: 12 }}>
                          已上传：{designImage.fileName || designImage.id}
                        </Text>
                      ) : null}
                    </div>
                    <input
                      ref={fileRef}
                      hidden
                      type="file"
                      accept="image/*"
                      onChange={(e) => {
                        void onFile(e.target.files?.[0]);
                        e.currentTarget.value = '';
                      }}
                    />
                  </div>
                  <Button
                    type="primary"
                    size="large"
                    loading={busy}
                    disabled={!designImage}
                    onClick={() => void run()}
                  >
                    开始分析
                  </Button>
                </Space>
              </Card>

              {error ? <Alert type="error" showIcon message="分析失败" description={error} /> : null}

              {/* ---------- 结果区 ---------- */}
              {result ? (
                <>
                  <div className="module-hero module-hero-aesthetic">
                    <div className="module-hero-main">
                      <Text className="module-hero-kicker">Aesthetic Quant</Text>
                      <Title level={2} className="module-hero-title">
                        美学量化分析
                      </Title>
                      <Paragraph className="module-hero-description">
                        围绕图像、ROI 与注意力，输出多维度美学量化结果与优化建议。
                      </Paragraph>
                      <div className="module-hero-meta">
                        <Text className="module-hero-pill">画像：{result.profileId}</Text>
                        <Text className="module-hero-pill">深度：{result.depth}</Text>
                        <Text className="module-hero-pill">置信度：{result.confidence.level}</Text>
                      </div>
                    </div>
                  </div>

                  <Card className="page-card aes-summary-card">
                    <div className="aes-summary-layout">
                      <div className="aes-summary-score">
                        <Text type="secondary" style={{ fontWeight: 600 }}>综合分</Text>
                        <span className="aes-summary-score-value">{result.overallScore ?? '-'}</span>
                        <Tag color={confidenceColor[result.confidence.level] || 'default'}>
                          置信度 {result.confidence.level} · {result.confidence.score}
                        </Tag>
                      </div>
                      <Paragraph style={{ marginBottom: 0 }}>{result.summary}</Paragraph>
                    </div>
                  </Card>

                  {dims ? (
                    <div className="aes-dim-grid">
                      {dimLabels.map(({ key, label }) => {
                        const value = dims[key];
                        if (value === undefined) return null;
                        return (
                          <Card key={key} className="aes-metric-card">
                            <Statistic title={label} value={value} />
                          </Card>
                        );
                      })}
                    </div>
                  ) : null}

                  <div className="aes-two-col">
                    {whole ? (
                      <Card title="整图指标" className="page-card module-section-card">
                        <Descriptions column={1} size="small">
                          <Descriptions.Item label="主色">
                            <Space>
                              <span
                                style={{
                                  display: 'inline-block',
                                  width: 16,
                                  height: 16,
                                  borderRadius: 4,
                                  background: whole.dominantColor,
                                  border: '1px solid rgba(0,0,0,0.1)',
                                }}
                              />
                              {whole.dominantColor}
                            </Space>
                          </Descriptions.Item>
                          <Descriptions.Item label="亮度">{whole.brightness}</Descriptions.Item>
                          <Descriptions.Item label="饱和度">{whole.saturation}</Descriptions.Item>
                          <Descriptions.Item label="边缘密度">{whole.edgeDensity}</Descriptions.Item>
                          <Descriptions.Item label="纹理复杂度">{whole.textureComplexity}</Descriptions.Item>
                          <Descriptions.Item label="色彩复杂度">{whole.colorComplexity}</Descriptions.Item>
                          <Descriptions.Item label="得分">{whole.score}</Descriptions.Item>
                          <Descriptions.Item label="文字建议">{whole.textRecommendation}</Descriptions.Item>
                        </Descriptions>
                      </Card>
                    ) : null}

                    {pair ? (
                      <Card title="前后景配对" className="page-card module-section-card">
                        <Descriptions column={1} size="small">
                          <Descriptions.Item label="对比度">{pair.contrastRatio}</Descriptions.Item>
                          <Descriptions.Item label="亮度差">{pair.brightnessDelta}</Descriptions.Item>
                          <Descriptions.Item label="饱和度差">{pair.saturationDelta}</Descriptions.Item>
                          <Descriptions.Item label="和谐理论">{pair.harmonyTheory}</Descriptions.Item>
                          <Descriptions.Item label="得分">{pair.score}</Descriptions.Item>
                        </Descriptions>
                      </Card>
                    ) : null}
                  </div>

                  {attn ? (
                    <Card title="启发式注意力" className="page-card module-section-card">
                      <Space direction="vertical" size={12} style={{ width: '100%' }}>
                        <Paragraph style={{ marginBottom: 0 }}>{attn.summary}</Paragraph>
                        <Space wrap size={32}>
                          <Statistic title="峰值注意力" value={attn.peakAttentionScore} />
                          <Statistic title="焦点平衡" value={attn.focusBalanceScore} />
                          <Statistic title="分散风险" value={attn.distractionRiskScore} />
                        </Space>
                      </Space>
                    </Card>
                  ) : null}

                  {result.roiResults.length ? (
                    <Card title="ROI 区域" className="page-card module-section-card">
                      <List
                        dataSource={result.roiResults}
                        renderItem={(r) => (
                          <List.Item>
                            <Space direction="vertical" size={6} style={{ width: '100%' }}>
                              <Space wrap>
                                <Text strong>{r.label}</Text>
                                <Tag color="orange">得分 {r.score}</Tag>
                                {r.attentionRank !== undefined ? <Tag>注意力排名 {r.attentionRank}</Tag> : null}
                              </Space>
                              <Space wrap>
                                <Tag>亮度 {r.brightness}</Tag>
                                <Tag>饱和度 {r.saturation}</Tag>
                                <Tag>边缘密度 {r.edgeDensity}</Tag>
                                {r.attentionAverage !== undefined ? <Tag>注意力均值 {r.attentionAverage}</Tag> : null}
                              </Space>
                            </Space>
                          </List.Item>
                        )}
                      />
                    </Card>
                  ) : null}

                  {result.findings.length || result.recommendations.length ? (
                    <div className="aes-two-col">
                      {result.findings.length ? (
                        <Card title="发现" className="page-card module-section-card">
                          <List
                            size="small"
                            dataSource={result.findings}
                            renderItem={(item) => <List.Item>{item}</List.Item>}
                          />
                        </Card>
                      ) : null}
                      {result.recommendations.length ? (
                        <Card title="优化建议" className="page-card module-section-card">
                          <List
                            size="small"
                            dataSource={result.recommendations}
                            renderItem={(item) => <List.Item>{item}</List.Item>}
                          />
                        </Card>
                      ) : null}
                    </div>
                  ) : null}

                  {result.boundaryNotes.length || result.warnings.length ? (
                    <Row gutter={16}>
                      <Col span={12}>
                        {result.boundaryNotes.length ? (
                          <Card title="边界说明" className="page-card module-section-card">
                            <List
                              size="small"
                              dataSource={result.boundaryNotes}
                              renderItem={(item) => <List.Item>{item}</List.Item>}
                            />
                          </Card>
                        ) : null}
                      </Col>
                      <Col span={12}>
                        {result.warnings.length ? (
                          <Card title="提醒" className="page-card module-section-card">
                            <List
                              size="small"
                              dataSource={result.warnings}
                              renderItem={(item) => <List.Item>{item}</List.Item>}
                            />
                          </Card>
                        ) : null}
                      </Col>
                    </Row>
                  ) : null}
                </>
              ) : (
                <Empty description="上传设计图并点击「开始分析」查看结果" />
              )}
            </div>
          </Content>
        </Layout>
      </Layout>
    </ConfigProvider>
  );
};
